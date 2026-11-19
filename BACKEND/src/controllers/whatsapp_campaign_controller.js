const WhatsAppCampaign = require("../models/WhatsAppCampaign");
const WhatsAppCampaignLog = require("../models/WhatsAppCampaignLog");
const WhatsAppTemplateCondition = require("../models/WhatsAppTemplateCondition");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const LeadStatus = require("../models/LeadStatus");
const Client = require("../models/Client");
const { getActiveIntegration, sendTemplateMessage } = require("../services/whatsapp_service");
const {
  getMergedTemplates,
  warmCache,
  createTemplate: createMetaTemplate,
  uploadHeaderSample,
} = require("../services/whatsapp_template_service");

const RATE_LIMIT_DELAY_MS = 100;

const getTemplates = async (req, res) => {
  try {
    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) {
      return res.json({ data: [], liveMode: false, fetchedFromMeta: false, message: "No WhatsApp number connected yet" });
    }
    const force = req.query.refresh === "true";
    const templates = await getMergedTemplates(integration, force);
    res.json({
      data: req.query.all === "true" ? templates : templates.filter((t) => t.status === "APPROVED"),
      liveMode: integration.is_live,
      fetchedFromMeta: templates.length > 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Submits a template to Meta on the tenant's behalf — Meta still owns
// approval, this just means the tenant never has to leave the CRM to author
// one. Shows up back in getTemplates as PENDING once the cache is refreshed.
const createTemplate = async (req, res) => {
  try {
    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) {
      return res.status(400).json({ message: "Connect a WhatsApp number first (Connect tab)" });
    }

    // JSON, or multipart when an IMAGE header sample is attached (field "image").
    const { category, language, body, header, footer, headerExample } = req.body;
    const name = String(req.body.name || "").trim().toLowerCase();
    const headerType = req.body.headerType === "IMAGE" ? "IMAGE" : "TEXT";
    let bodyExamples = req.body.bodyExamples || [];
    if (typeof bodyExamples === "string") bodyExamples = JSON.parse(bodyExamples);

    if (!name || !category || !body) {
      return res.status(400).json({ message: "Name, category and body text are required" });
    }
    if (!/^[a-z0-9_]+$/.test(name)) {
      return res.status(400).json({ message: "Template name may only use small letters, numbers and _" });
    }
    if (headerType === "IMAGE" && !req.file) {
      return res.status(400).json({ message: "Choose a sample image for the image header" });
    }
    if (req.file && !/^image\/(jpeg|png)$/.test(req.file.mimetype || "")) {
      return res.status(400).json({ message: "The header image must be a JPG or PNG" });
    }

    try {
      const headerHandle = headerType === "IMAGE" ? await uploadHeaderSample(integration, req.file) : null;
      await createMetaTemplate(integration, {
        name, category, language, body, header, footer, bodyExamples, headerType, headerHandle, headerExample,
      });
    } catch (apiErr) {
      const fb = apiErr.response?.data?.error;
      const fbMessage = fb?.error_user_msg || fb?.message || apiErr.message;
      return res.status(400).json({
        message: fbMessage ? `Meta rejected this template: ${fbMessage}` : "Could not submit template to Meta.",
      });
    }

    await getMergedTemplates(integration, true);
    res.json({ message: "Template submitted to Meta for review" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCampaigns = async (req, res) => {
  try {
    const campaigns = await WhatsAppCampaign.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: -1 });
    res.json({ data: campaigns });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCampaignLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, campaignId, status, search } = req.query;
    const cappedLimit = Math.min(parseInt(limit, 10) || 50, 200);
    const filter = { tenant_id: req.user.tenant_id };
    if (campaignId) filter.campaign_id = campaignId;
    if (status) filter.status = status;
    if (search) filter.mobile = { $regex: search, $options: "i" };

    const total = await WhatsAppCampaignLog.countDocuments(filter);
    const data = await WhatsAppCampaignLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((parseInt(page, 10) - 1) * cappedLimit)
      .limit(cappedLimit);

    res.json({ data, total, page: parseInt(page, 10), totalPages: Math.ceil(total / cappedLimit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDeliveryAnalytics = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const integration = await getActiveIntegration(tenantId);

    const funnelRows = await WhatsAppCampaignLog.aggregate([
      { $match: { tenant_id: tenantId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const funnel = { sent: 0, delivered: 0, read: 0, failed: 0 };
    let optOuts = 0;
    for (const row of funnelRows) {
      if (row._id === "Sent") funnel.sent = row.count;
      else if (row._id === "Delivered") funnel.delivered = row.count;
      else if (row._id === "Read") funnel.read = row.count;
      else if (row._id === "Failed") funnel.failed = row.count;
      else if (row._id === "OptedOut") optOuts = row.count;
    }
    const totalSent = funnel.sent + funnel.delivered + funnel.read + funnel.failed;
    funnel.deliveredRate = totalSent > 0 ? Math.round(((funnel.delivered + funnel.read) / totalSent) * 100) : 0;
    funnel.readRate = totalSent > 0 ? Math.round((funnel.read / totalSent) * 100) : 0;

    const perTemplateRows = await WhatsAppCampaignLog.aggregate([
      { $match: { tenant_id: tenantId } },
      {
        $group: {
          _id: "$template_id",
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $in: ["$status", ["Delivered", "Read"]] }, 1, 0] } },
          read: { $sum: { $cond: [{ $eq: ["$status", "Read"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "Failed"] }, 1, 0] } },
        },
      },
    ]);

    res.json({
      liveMode: integration?.is_live || false,
      data: {
        funnel,
        perTemplate: perTemplateRows.map((r) => ({ templateId: r._id, label: r._id, ...r })),
        optOuts,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const AUDIENCE_SOURCES = ["leads", "selected_leads", "customers", "upload"];

// Multipart (image) requests send every field as a string — "false" must stay false.
const toBool = (v) => v === true || v === "true";
const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const toIds = (v) =>
  (Array.isArray(v) ? v : []).filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

// Audience fields shared by create, update and the audience preview. Only the
// fields present in `body` are returned, so a partial update leaves the rest alone.
const audienceFieldsFrom = (body) => {
  const out = {};
  if (body.audienceSource !== undefined) {
    out.audience_source = AUDIENCE_SOURCES.includes(body.audienceSource) ? body.audienceSource : "leads";
  }
  if (body.targetAudience !== undefined) out.target_audience = body.targetAudience || "";
  if (body.recipients !== undefined) {
    out.recipients = (parseJson(body.recipients) || [])
      .filter((r) => r && String(r.mobile || "").replace(/\D/g, "").length >= 10)
      .map((r) => ({ name: String(r.name || "").trim(), mobile: String(r.mobile).trim() }));
  }
  if (body.leadStatusIds !== undefined) out.lead_status_ids = toIds(parseJson(body.leadStatusIds));
  if (body.leadSourceIds !== undefined) out.lead_source_ids = toIds(parseJson(body.leadSourceIds));
  if (body.leadIds !== undefined) out.lead_ids = toIds(parseJson(body.leadIds));
  if (body.customerIds !== undefined) out.customer_ids = toIds(parseJson(body.customerIds));
  return out;
};

const createCampaign = async (req, res) => {
  try {
    let { name, templateId, templateParams } = req.body;
    if (typeof templateParams === "string") templateParams = JSON.parse(templateParams);
    const recurring = toBool(req.body.recurring);
    const audience = audienceFieldsFrom(req.body);

    if (!name || !templateId) {
      return res.status(400).json({ message: "Campaign name and template are required" });
    }

    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) {
      return res.status(400).json({ message: "Connect a WhatsApp number first (Setup > WhatsApp)" });
    }

    const templates = await getMergedTemplates(integration);
    const template = templates.find((t) => t.id === templateId);
    if (template?.requiresImage && !req.file) {
      return res.status(400).json({ message: "This template requires a header image" });
    }

    let imageMediaUrl = null;
    if (req.file) {
      const upload = require("../hrms/utils/cloudinary_config");
      imageMediaUrl = await upload.uploadToCloudinary(req.file, "whatsapp_campaigns");
    }

    const campaign = await WhatsAppCampaign.create({
      tenant_id: req.user.tenant_id,
      name,
      template_id: templateId,
      image_media_url: imageMediaUrl,
      template_params: templateParams || {},
      audience_source: "leads",
      ...audience,
      recurring,
      status: recurring ? "Scheduled" : "Draft",
      created_by: req.user._id,
    });

    res.json(campaign);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateCampaign = async (req, res) => {
  try {
    let { name, templateId, templateParams } = req.body;
    if (typeof templateParams === "string") templateParams = JSON.parse(templateParams);

    const campaign = await WhatsAppCampaign.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    if (campaign.status === "InProgress") {
      return res.status(400).json({ message: "Cannot edit a campaign that is currently sending" });
    }

    if (req.file) {
      const upload = require("../hrms/utils/cloudinary_config");
      campaign.image_media_url = await upload.uploadToCloudinary(req.file, "whatsapp_campaigns");
    }

    if (name !== undefined) campaign.name = name;
    if (templateId !== undefined) campaign.template_id = templateId;
    if (templateParams !== undefined) campaign.template_params = templateParams;
    campaign.set(audienceFieldsFrom(req.body));
    if (req.body.recurring !== undefined) {
      campaign.recurring = toBool(req.body.recurring);
      // The monthly cron only picks up "Scheduled" campaigns.
      if (campaign.status === "Draft" && campaign.recurring) campaign.status = "Scheduled";
      if (campaign.status === "Scheduled" && !campaign.recurring) campaign.status = "Draft";
    }

    await campaign.save();
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCampaign = async (req, res) => {
  try {
    const deleted = await WhatsAppCampaign.findOneAndDelete({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!deleted) return res.status(404).json({ message: "Campaign not found" });
    res.json({ message: "Campaign deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every audience resolves to [{ _id (lead), client_id, name, phonenumber }].
// A number is messaged once per run, and numbers that replied STOP (lead
// whatsapp_opt_out) are skipped whatever the audience.
const finalizeTargets = async (tenantId, targets) => {
  const optedOut = new Set(
    await Lead.find({ tenant_id: tenantId, whatsapp_opt_out: true, phone_last10: { $exists: true, $ne: null } }).distinct("phone_last10")
  );
  const seen = new Set();
  return targets.filter((t) => {
    const key = last10(t.phonenumber);
    if (key.length < 10 || seen.has(key) || optedOut.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const leadTarget = (l) => ({ _id: l._id, client_id: null, name: l.name, phonenumber: l.phonenumber });

// Priority by audience_source: a fixed list (upload), picked leads, customers,
// or a live Lead query built from the template's audience condition
// (recency/frequency cap/status include-exclude) plus the tag/status/source filters.
const resolveTargetCustomers = async (campaign) => {
  const tenantId = campaign.tenant_id;

  if (campaign.audience_source === "upload") {
    return finalizeTargets(
      tenantId,
      (campaign.recipients || []).map((r) => ({ _id: null, client_id: null, name: r.name, phonenumber: r.mobile }))
    );
  }

  if (campaign.audience_source === "selected_leads") {
    const leads = await Lead.find({
      tenant_id: tenantId,
      _id: { $in: campaign.lead_ids || [] },
      phonenumber: { $exists: true, $ne: "" },
    }).select("name phonenumber");
    return finalizeTargets(tenantId, leads.map(leadTarget));
  }

  if (campaign.audience_source === "customers") {
    const query = { tenant_id: tenantId, active: { $ne: false } };
    if (campaign.customer_ids?.length) query._id = { $in: campaign.customer_ids };
    const clients = await Client.find(query).select("company contact_person phonenumber phoneE164");
    return finalizeTargets(
      tenantId,
      clients.map((c) => ({
        _id: null,
        client_id: c._id,
        name: c.contact_person || c.company,
        phonenumber: c.phoneE164 || c.phonenumber,
      }))
    );
  }

  const condition = await WhatsAppTemplateCondition.findOne({
    tenant_id: tenantId,
    template_id: campaign.template_id,
    is_active: true,
  });

  const query = {
    tenant_id: tenantId,
    whatsapp_opt_out: { $ne: true },
    junk: { $ne: true },
    lost: { $ne: true },
    phonenumber: { $exists: true, $ne: "" },
  };

  if (campaign.target_audience) {
    query.tags = { $regex: escapeRegex(campaign.target_audience), $options: "i" };
  }
  if (campaign.lead_source_ids?.length) query.source = { $in: campaign.lead_source_ids };

  if (condition?.recency_days > 0) {
    query.dateadded = { $gte: new Date(Date.now() - condition.recency_days * 24 * 60 * 60 * 1000) };
  }

  // Statuses picked on the campaign win over the template's audience rule.
  if (campaign.lead_status_ids?.length) {
    query.status = { $in: campaign.lead_status_ids };
  } else if (condition?.include_statuses?.length > 0) {
    const statuses = await LeadStatus.find({ tenant_id: tenantId, name: { $in: condition.include_statuses } });
    query.status = { $in: statuses.map((s) => s._id) };
  } else if (condition?.exclude_statuses?.length > 0) {
    const statuses = await LeadStatus.find({ tenant_id: tenantId, name: { $in: condition.exclude_statuses } });
    query.status = { $nin: statuses.map((s) => s._id) };
  }

  let leads = await Lead.find(query).select("name phonenumber");

  if (condition?.frequency_cap?.max_messages > 0 && leads.length > 0) {
    const periodStart = new Date(Date.now() - condition.frequency_cap.period_days * 24 * 60 * 60 * 1000);
    const counts = await WhatsAppCampaignLog.aggregate([
      { $match: { tenant_id: tenantId, lead_id: { $in: leads.map((l) => l._id) }, createdAt: { $gte: periodStart } } },
      { $group: { _id: "$lead_id", count: { $sum: 1 } } },
    ]);
    const overCap = new Set(
      counts.filter((c) => c.count >= condition.frequency_cap.max_messages).map((c) => String(c._id))
    );
    leads = leads.filter((l) => !overCap.has(String(l._id)));
  }

  return finalizeTargets(tenantId, leads.map(leadTarget));
};

// "N people will receive this" for the campaign form, computed exactly as a
// real run would — read-only, nothing is saved.
const previewAudience = async (req, res) => {
  try {
    const draft = {
      tenant_id: req.user.tenant_id,
      template_id: req.body.templateId || "",
      audience_source: "leads",
      ...audienceFieldsFrom(req.body),
    };
    const targets = await resolveTargetCustomers(draft);
    const mask = (p) => {
      const d = String(p || "").replace(/\D/g, "");
      return d.length > 4 ? `${"•".repeat(Math.max(d.length - 4, 0))}${d.slice(-4)}` : d;
    };
    res.json({
      count: targets.length,
      sample: targets.slice(0, 5).map((t) => ({ name: t.name || "", mobile: mask(t.phonenumber) })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const resolveBodyParams = (campaign, customer, variables) => {
  return variables.map((v) => {
    if (v.source === "lead.name") return customer.name || "Customer";
    const val = campaign.template_params?.[String(v.index)] ?? campaign.template_params?.[`param${v.index}`];
    return (val && String(val).trim()) ? String(val).trim() : "-";
  });
};

const processCampaignMessages = async (campaign, customers, integration) => {
  const templates = await getMergedTemplates(integration);
  const template = templates.find((t) => t.id === campaign.template_id);
  const variables = template?.variables || [];

  for (const customer of customers) {
    const fresh = await WhatsAppCampaign.findById(campaign._id).select("stop_requested");
    if (fresh?.stop_requested) break;

    const bodyParams = resolveBodyParams(campaign, customer, variables);
    const languageCode = template?.language || "en_US";
    const result = await sendTemplateMessage(
      integration,
      customer.phonenumber,
      campaign.template_id,
      bodyParams,
      campaign.image_media_url,
      languageCode
    );

    await WhatsAppCampaignLog.create({
      tenant_id: campaign.tenant_id,
      campaign_id: campaign._id,
      lead_id: customer._id || null,
      client_id: customer.client_id || null,
      mobile: customer.phonenumber,
      status: result.success ? "Sent" : "Failed",
      message_id: result.messageId || null,
      template_id: campaign.template_id,
      error: result.error || null,
    });

    // Only successful sends count, and progress is saved as it goes so the
    // Campaigns tab (polling every 3s) shows it live.
    if (result.success) {
      campaign.sent_count += 1;
      await WhatsAppCampaign.updateOne({ _id: campaign._id }, { sent_count: campaign.sent_count });
    }
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  const finalDoc = await WhatsAppCampaign.findById(campaign._id);
  if (finalDoc.stop_requested) {
    finalDoc.status = "Cancelled";
  } else if (finalDoc.recurring) {
    // Left "Scheduled" (not "Completed") so the monthly cron picks it up again next cycle.
    finalDoc.status = "Scheduled";
  } else {
    finalDoc.status = "Completed";
  }
  finalDoc.sent_count = campaign.sent_count;
  await finalDoc.save();
};

const runCampaign = async (campaign) => {
  campaign.status = "InProgress";
  campaign.stop_requested = false;
  campaign.sent_count = 0;
  await campaign.save();

  const integration = await getActiveIntegration(campaign.tenant_id);
  if (!integration) {
    campaign.status = "Failed";
    await campaign.save();
    return { targeted: 0, error: "No WhatsApp number connected" };
  }

  let targets;
  try {
    targets = await resolveTargetCustomers(campaign);
  } catch (err) {
    // Never leave a campaign stuck in "InProgress" when the audience can't be built.
    campaign.status = "Failed";
    await campaign.save();
    throw err;
  }
  await warmCache(integration);

  processCampaignMessages(campaign, targets, integration).catch((err) =>
    console.error("[WA Campaign] processing error:", err.message)
  );

  return { targeted: targets.length };
};

const triggerCampaign = async (req, res) => {
  try {
    const campaign = await WhatsAppCampaign.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    if (campaign.status === "InProgress") {
      return res.status(400).json({ message: "Campaign is already sending" });
    }

    if (campaign.audience_source === "upload" && req.body.recipients) {
      campaign.recipients = req.body.recipients;
      await campaign.save();
    }

    const result = await runCampaign(campaign);
    res.json({ message: "Campaign triggered", ...result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const stopCampaign = async (req, res) => {
  try {
    const campaign = await WhatsAppCampaign.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { stop_requested: true },
      { new: true }
    );
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    res.json({ message: "Stop requested", campaign });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Unsticks a campaign left "InProgress" (e.g. the server restarted mid-send,
// so the in-memory sending loop is gone). Messages already sent stay logged;
// the campaign just becomes triggerable/editable again.
const resetCampaign = async (req, res) => {
  try {
    const campaign = await WhatsAppCampaign.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    if (campaign.status !== "InProgress") {
      return res.status(400).json({ message: "Only a campaign stuck in InProgress can be reset" });
    }
    campaign.status = campaign.recurring ? "Scheduled" : "Draft";
    campaign.stop_requested = true; // a still-running loop (if any) stops at its next message
    await campaign.save();
    res.json({ message: "Campaign reset", campaign });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  resetCampaign,
  getTemplates,
  createTemplate,
  getCampaigns,
  getCampaignLogs,
  getDeliveryAnalytics,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  triggerCampaign,
  stopCampaign,
  previewAudience,
  runCampaign, // reused directly by the monthly cron job (src/cron/whatsappMonthlyCampaign.js)
};
