const WhatsAppInbox = require("../models/WhatsAppInbox");
const Lead = require("../models/Lead");
const { getActiveIntegration, sendWhatsAppMessageResult, sendTemplateMessage } = require("../services/whatsapp_service");
const { getMergedTemplates } = require("../services/whatsapp_template_service");

const WINDOW_MS = 24 * 60 * 60 * 1000;

const last10 = (mobile) => String(mobile || "").replace(/\D/g, "").slice(-10);

// Threads are keyed on the last 10 digits, so reply to the full number the
// customer actually wrote from (keeps non-Indian country codes intact).
const replyTarget = async (tenantId, mobile) => {
  const lastInbound = await WhatsAppInbox.findOne({ tenant_id: tenantId, mobile, direction: "in" })
    .sort({ received_at: -1 })
    .select("from");
  const from = String(lastInbound?.from || "").replace(/\D/g, "");
  return from.length >= 10 ? from : mobile;
};

// phone_last10 is filled by the Lead pre-save hook; leads saved before it
// existed fall back to a digits-only suffix match on phonenumber.
const findLead = async (tenantId, mobile, select = "_id") => {
  const key = last10(mobile);
  if (key.length < 10) return null;
  return (
    (await Lead.findOne({ tenant_id: tenantId, phone_last10: key }).select(select)) ||
    Lead.findOne({ tenant_id: tenantId, phonenumber: { $regex: key + "$" } }).select(select)
  );
};

// Flat legacy list — one row per message needing attention (mirrors the
// original single-list "Inbox" tab before conversations were grouped).
const getInbox = async (req, res) => {
  try {
    const rows = await WhatsAppInbox.find({ tenant_id: req.user.tenant_id, direction: "in" })
      .sort({ received_at: -1 })
      .limit(200);
    res.json({ data: rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const replyToMessage = async (req, res) => {
  try {
    const row = await WhatsAppInbox.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!row) return res.status(404).json({ message: "Message not found" });

    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) return res.status(400).json({ message: "Connect a WhatsApp number first" });
    const result = await sendWhatsAppMessageResult(integration, await replyTarget(req.user.tenant_id, row.mobile), req.body.text);
    if (!result.success) return res.status(400).json({ message: result.error, outsideWindow: !!result.outsideWindow });
    const messageId = result.messageId;

    await WhatsAppInbox.create({
      tenant_id: req.user.tenant_id,
      from: integration?.display_phone_number || "",
      mobile: row.mobile,
      message: req.body.text,
      msg_type: "text",
      wa_message_id: messageId,
      lead_id: row.lead_id,
      direction: "out",
      delivery_status: "sent",
      received_at: new Date(),
    });

    row.reply_status = "replied";
    row.reply_text = req.body.text;
    row.reply_at = new Date();
    row.replied_by = req.user._id;
    await row.save();

    res.json({ message: "Reply sent" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ignoreMessage = async (req, res) => {
  try {
    const row = await WhatsAppInbox.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { reply_status: "ignored" },
      { new: true }
    );
    if (!row) return res.status(404).json({ message: "Message not found" });
    res.json(row);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One row per distinct contact, with unread count + last message preview.
const getConversations = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const conversations = await WhatsAppInbox.aggregate([
      { $match: { tenant_id: tenantId } },
      { $sort: { received_at: -1 } },
      {
        $group: {
          _id: "$mobile",
          lastMessage: { $first: "$message" },
          lastMessageAt: { $first: "$received_at" },
          senderName: { $first: "$sender_name" },
          leadId: { $first: "$lead_id" },
          unreadCount: {
            $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$reply_status", "pending"] }] }, 1, 0] },
          },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);
    res.json({ data: conversations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getConversationMessages = async (req, res) => {
  try {
    // Newest 500, shown oldest-first.
    const rows = (
      await WhatsAppInbox.find({ tenant_id: req.user.tenant_id, mobile: req.params.mobile })
        .sort({ received_at: -1 })
        .limit(500)
    ).reverse();
    // Opening a thread counts as reading it.
    await WhatsAppInbox.updateMany(
      { tenant_id: req.user.tenant_id, mobile: req.params.mobile, direction: "in", reply_status: "pending" },
      { reply_status: "read" }
    );
    res.json({ data: rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getWindowStatus = async (req, res) => {
  try {
    const lastInbound = await WhatsAppInbox.findOne({
      tenant_id: req.user.tenant_id,
      mobile: req.params.mobile,
      direction: "in",
    }).sort({ received_at: -1 });

    const withinWindow = !!lastInbound && Date.now() - new Date(lastInbound.received_at).getTime() < WINDOW_MS;
    res.json({ withinWindow, lastInboundAt: lastInbound?.received_at || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getContactInfo = async (req, res) => {
  try {
    const lead = await findLead(req.user.tenant_id, req.params.mobile, "name email company tags status");
    res.json({ data: lead || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const replyToConversation = async (req, res) => {
  try {
    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) return res.status(400).json({ message: "Connect a WhatsApp number first" });

    let mediaUrl = null;
    let msgType = "text";
    if (req.file) {
      const upload = require("../hrms/utils/cloudinary_config");
      mediaUrl = await upload.uploadToCloudinary(req.file, "whatsapp_inbox");
      msgType = req.file.mimetype?.startsWith("image/") ? "image" : "document";
    }

    const lead = await findLead(req.user.tenant_id, req.params.mobile);

    const result = await sendWhatsAppMessageResult(
      integration,
      await replyTarget(req.user.tenant_id, req.params.mobile),
      req.body.text || "",
      mediaUrl,
      msgType
    );
    if (!result.success) return res.status(400).json({ message: result.error, outsideWindow: !!result.outsideWindow });
    const messageId = result.messageId;

    const row = await WhatsAppInbox.create({
      tenant_id: req.user.tenant_id,
      from: integration.display_phone_number || "",
      mobile: req.params.mobile,
      message: req.body.text || "",
      msg_type: msgType,
      wa_message_id: messageId,
      media_url: mediaUrl,
      lead_id: lead?._id || null,
      direction: "out",
      delivery_status: "sent",
      received_at: new Date(),
    });

    res.json(row);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Reopens a cold (>24h) conversation — only an approved template can be sent
// outside Meta's customer-service window.
const sendTemplateToConversation = async (req, res) => {
  try {
    const integration = await getActiveIntegration(req.user.tenant_id);
    if (!integration) return res.status(400).json({ message: "Connect a WhatsApp number first" });

    let { templateId, bodyParams } = req.body;
    if (typeof bodyParams === "string") bodyParams = JSON.parse(bodyParams);
    const templates = await getMergedTemplates(integration);
    const template = templates.find((t) => t.id === templateId);
    if (!template) return res.status(400).json({ message: "Template not found or not approved yet" });

    let imageUrl = null;
    if (template.requiresImage) {
      if (!req.file) return res.status(400).json({ message: "This template needs a header image" });
      const upload = require("../hrms/utils/cloudinary_config");
      imageUrl = await upload.uploadToCloudinary(req.file, "whatsapp_inbox");
    }

    const result = await sendTemplateMessage(
      integration,
      await replyTarget(req.user.tenant_id, req.params.mobile),
      templateId,
      bodyParams || [],
      imageUrl,
      template.language
    );
    if (!result.success) return res.status(400).json({ message: result.error || "Send failed" });

    const lead = await findLead(req.user.tenant_id, req.params.mobile);

    const row = await WhatsAppInbox.create({
      tenant_id: req.user.tenant_id,
      from: integration.display_phone_number || "",
      mobile: req.params.mobile,
      message: `[Template: ${templateId}]`,
      msg_type: imageUrl ? "image" : "text",
      media_url: imageUrl,
      wa_message_id: result.messageId,
      lead_id: lead?._id || null,
      direction: "out",
      delivery_status: "sent",
      received_at: new Date(),
    });

    res.json(row);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getInbox,
  replyToMessage,
  ignoreMessage,
  getConversations,
  getConversationMessages,
  getWindowStatus,
  getContactInfo,
  replyToConversation,
  sendTemplateToConversation,
};
