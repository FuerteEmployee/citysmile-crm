const MetaIntegration = require("../models/MetaIntegration");
const { upsertLeadFromMeta } = require("../services/metaLeadService");
const axios = require("axios");

const verifyWebhook = async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
  
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('[Meta Webhook] GET Verification Successful');
    return res.status(200).send(challenge);
  } else {
    console.warn('[Meta Webhook] GET Verification Failed. Token mismatch or bad query.');
    return res.sendStatus(403);
  }
};

const receiveWebhook = async (req, res) => {
  const body = req.body;
  console.log("[Meta Webhook] POST Received payload:", JSON.stringify(body));

  if (body.object === "page") {
    try {
      for (const entry of body.entry) {
        if (!entry.changes) continue;
        for (const change of entry.changes) {
          if (change.field === "leadgen") {
            const leadgenId = change.value.leadgen_id;
            const pageId = change.value.page_id;
            console.log(`[Meta Webhook] Processing leadgen_id: ${leadgenId} on page: ${pageId}`);

            // Resolve which tenant this Page belongs to from the admin-connected
            // integration first; fall back to the legacy single-tenant env vars
            // so pages connected before this table existed keep working.
            const integration = await MetaIntegration.findOne({ page_id: pageId });
            const token = integration?.page_access_token || process.env[`META_PAGE_ACCESS_TOKEN_${pageId}`] || process.env.META_PAGE_ACCESS_TOKEN;
            const tenantId = integration?.tenant_id || process.env.TENANT_ID;

            if (!token) {
              console.error(`[Meta Webhook] No Page Access Token found for page ${pageId} (not connected, and no META_PAGE_ACCESS_TOKEN fallback)`);
              continue;
            }

            try {
              // form_id/field_data/created_time aren't returned by default —
              // must be requested explicitly, same as the manual Import path.
              const response = await axios.get(`https://graph.facebook.com/v19.0/${leadgenId}`, {
                params: { access_token: token, fields: "form_id,field_data,created_time" }
              });

              const leadData = response.data;
              console.log("[Meta Graph API] Lead details fetched:", JSON.stringify(leadData));

              // Tag with which specific form this came from, same as the
              // manual Import path, so a lead that arrives live via webhook
              // gets the same ad-tab/dynamic-column treatment as one pulled
              // in by clicking Import — not a second-class path that's stuck
              // with the generic "Meta Ads" bucket and no question columns.
              const form = integration?.forms?.find((f) => f.form_id === leadData.form_id);
              const questionLabels = Object.fromEntries((form?.questions || []).map((q) => [q.key, q.label]));

              const { created, lead } = await upsertLeadFromMeta({
                tenantId,
                leadgenId,
                fieldData: leadData.field_data,
                formId: leadData.form_id,
                formName: form?.name,
                questionLabels,
                createdTime: leadData.created_time,
                adId: change.value.ad_id,
              });

              console.log(
                created
                  ? `[Meta Webhook] Successfully created lead: ${lead._id}`
                  : `[Meta Webhook] Lead ${leadgenId} already imported, skipping duplicate (${lead._id})`
              );
            } catch (apiErr) {
              console.error("[Meta Webhook] Error calling Graph API or writing to DB:", apiErr.message);
              if (apiErr.response) {
                console.error("[Meta Webhook] Meta Graph API Response error:", JSON.stringify(apiErr.response.data));
              }
            }
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("[Meta Webhook] Processing error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.sendStatus(404);
  }
};

module.exports = {
  verifyWebhook,
  receiveWebhook
};
