const axios = require("axios");
const MetaIntegration = require("../models/MetaIntegration");
const { upsertLeadFromMeta } = require("../services/metaLeadService");

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";
const MAX_LEADS_PER_FORM = 500; // backstop against runaway pagination on huge forms
const MAX_FORMS = 1000; // backstop against runaway pagination on pages with huge form counts

const maskToken = (token) => {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
};

const fetchForms = async (pageId, accessToken) => {
  const forms = [];
  let url = `${GRAPH_API_BASE}/${pageId}/leadgen_forms`;
  let params = { access_token: accessToken, fields: "id,name,status,questions{key,label,type}", limit: 100 };

  while (url && forms.length < MAX_FORMS) {
    const response = await axios.get(url, { params });
    for (const f of response.data.data || []) {
      forms.push({
        form_id: f.id,
        name: f.name,
        status: f.status,
        questions: (f.questions || []).map((q) => ({ key: q.key, label: q.label, type: q.type })),
      });
    }
    url = response.data.paging?.next || null;
    params = undefined; // cursor URL from `paging.next` already carries the access_token
  }

  return forms;
};

// A tenant can connect several Pages at once, each with its own token, so this
// returns the full list rather than a single connection.
const getIntegration = async (req, res) => {
  try {
    const integrations = await MetaIntegration.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: 1 });
    res.json({
      connections: integrations.map((integration) => ({
        page_id: integration.page_id,
        page_name: integration.page_name,
        page_access_token_masked: maskToken(integration.page_access_token),
        forms: integration.forms,
        last_synced: integration.last_synced,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const connectPage = async (req, res) => {
  try {
    const { page_id, page_access_token } = req.body;
    if (!page_id || !page_access_token) {
      return res.status(400).json({ message: "Page ID and Page Access Token are required" });
    }

    const existing = await MetaIntegration.findOne({ page_id });
    if (existing && String(existing.tenant_id) !== String(req.user.tenant_id)) {
      return res.status(409).json({ message: "This Facebook Page is already connected to a different account." });
    }

    let pageName;
    try {
      const pageRes = await axios.get(`${GRAPH_API_BASE}/${page_id}`, {
        params: { access_token: page_access_token, fields: "name" },
      });
      pageName = pageRes.data.name;
    } catch (apiErr) {
      const fbMessage = apiErr.response?.data?.error?.message;
      console.error("[Meta] Page verify error:", JSON.stringify(apiErr.response?.data, null, 2));
      return res.status(400).json({
        message: fbMessage
          ? `Meta rejected this Page ID/Token: ${fbMessage}`
          : "Could not verify Page ID and Access Token with Meta. Please check both values.",
      });
    }

    // Auto-upgrade: if the token provided is a User Token, fetch the Page Access Token
    let resolvedPageToken = page_access_token;
    try {
      const pageTokenRes = await axios.get(`${GRAPH_API_BASE}/${page_id}`, {
        params: { access_token: page_access_token, fields: "access_token" },
      });
      if (pageTokenRes.data.access_token) {
        resolvedPageToken = pageTokenRes.data.access_token;
        console.log("[Meta] Auto-upgraded User Token → Page Access Token");
      }
    } catch (upgradeErr) {
      // If this fails, keep using the original token (it might already be a page token)
      console.log("[Meta] Token upgrade skipped, using provided token as-is");
    }

    let forms = [];
    try {
      forms = await fetchForms(page_id, resolvedPageToken);
    } catch (apiErr) {
      const fbMessage = apiErr.response?.data?.error?.message;
      console.error("[Meta] Lead forms error:", JSON.stringify(apiErr.response?.data, null, 2));
      return res.status(400).json({
        message: fbMessage
          ? `Connected to page but failed to load Lead Ads forms: ${fbMessage}`
          : "Connected to page but failed to load Lead Ads forms.",
      });
    }

    const integration = await MetaIntegration.findOneAndUpdate(
      { page_id },
      {
        tenant_id: req.user.tenant_id,
        page_id,
        page_name: pageName,
        page_access_token: resolvedPageToken,
        forms,
        connected_by: req.user._id,
        last_synced: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({
      page_id: integration.page_id,
      page_name: integration.page_name,
      page_access_token_masked: maskToken(integration.page_access_token),
      forms: integration.forms,
      last_synced: integration.last_synced,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });

  }
};

const syncForms = async (req, res) => {
  try {
    const integration = await MetaIntegration.findOne({
      tenant_id: req.user.tenant_id,
      page_id: req.params.pageId,
    });
    if (!integration) {
      return res.status(404).json({ message: "This Page isn't connected to your account" });
    }

    try {
      const forms = await fetchForms(integration.page_id, integration.page_access_token);
      integration.forms = forms;
      integration.last_synced = new Date();
      await integration.save();
    } catch (apiErr) {
      const fbMessage = apiErr.response?.data?.error?.message;
      return res.status(400).json({
        message: fbMessage ? `Failed to sync forms: ${fbMessage}` : "Failed to sync forms from Meta.",
      });
    }

    res.json({
      page_id: integration.page_id,
      page_name: integration.page_name,
      page_access_token_masked: maskToken(integration.page_access_token),
      forms: integration.forms,
      last_synced: integration.last_synced,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Pulls existing leads for one form (paginating through Meta's cursor), stopping
// at MAX_LEADS_PER_FORM so one huge form can't stall the request indefinitely.
const importLeadsForForm = async (formId, formName, questionLabels, accessToken, tenantId) => {
  let created = 0;
  let skipped = 0;
  let url = `${GRAPH_API_BASE}/${formId}/leads`;
  let params = { access_token: accessToken, fields: "id,field_data,created_time", limit: 100 };

  while (url) {
    const response = await axios.get(url, { params });
    const page = response.data.data || [];

    for (const leadEntry of page) {
      const { created: wasCreated } = await upsertLeadFromMeta({
        tenantId,
        leadgenId: leadEntry.id,
        fieldData: leadEntry.field_data,
        formId,
        formName,
        questionLabels,
        createdTime: leadEntry.created_time,
      });
      if (wasCreated) created++;
      else skipped++;
      if (created + skipped >= MAX_LEADS_PER_FORM) {
        return { created, skipped, truncated: true };
      }
    }

    url = response.data.paging?.next || null;
    params = undefined; // cursor URL from `paging.next` already carries the access_token
  }

  return { created, skipped, truncated: false };
};

const importLeads = async (req, res) => {
  try {
    const integration = await MetaIntegration.findOne({
      tenant_id: req.user.tenant_id,
      page_id: req.params.pageId,
    });
    if (!integration) {
      return res.status(404).json({ message: "This Page isn't connected to your account" });
    }

    const { form_id } = req.body;
    const formsToImport = form_id
      ? integration.forms.filter((f) => f.form_id === form_id)
      : integration.forms;

    if (formsToImport.length === 0) {
      return res.status(400).json({ message: "No matching Lead Ads form found on this connection" });
    }

    let totalCreated = 0;
    let totalSkipped = 0;
    let truncatedAny = false;

    for (const form of formsToImport) {
      try {
        const questionLabels = Object.fromEntries((form.questions || []).map((q) => [q.key, q.label]));
        const { created, skipped, truncated } = await importLeadsForForm(
          form.form_id,
          form.name,
          questionLabels,
          integration.page_access_token,
          req.user.tenant_id
        );
        totalCreated += created;
        totalSkipped += skipped;
        if (truncated) truncatedAny = true;
      } catch (apiErr) {
        console.error("[Meta] Import leads FULL error:", apiErr);
        const fbMessage = apiErr.response?.data?.error?.message;
        return res.status(400).json({
          message: fbMessage
            ? `Failed importing leads from form "${form.name}": ${fbMessage}`
            : `Failed importing leads from form "${form.name}": ${apiErr.message}`,
        });
      }
    }

    res.json({
      imported: totalCreated,
      skipped_duplicates: totalSkipped,
      truncated: truncatedAny,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const disconnect = async (req, res) => {
  try {
    const deleted = await MetaIntegration.findOneAndDelete({
      tenant_id: req.user.tenant_id,
      page_id: req.params.pageId,
    });
    if (!deleted) {
      return res.status(404).json({ message: "This Page isn't connected to your account" });
    }
    res.json({ message: "Meta Page disconnected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getIntegration, connectPage, syncForms, importLeads, disconnect };
