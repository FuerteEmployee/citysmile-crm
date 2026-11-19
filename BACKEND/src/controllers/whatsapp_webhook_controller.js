const crypto = require("crypto");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const WhatsAppCampaignLog = require("../models/WhatsAppCampaignLog");
const WhatsAppInbox = require("../models/WhatsAppInbox");
const Lead = require("../models/Lead");
const { sendWhatsAppMessage, downloadWhatsAppMedia } = require("../services/whatsapp_service");
const { upsertLeadFromWhatsApp } = require("../services/whatsappLeadService");
const { tenantHasFeature } = require("../utils/tenantFeatures");

// Single shared token, exactly like the existing Meta Lead Ads webhook
// (webhook_controller.js) — every tenant's WhatsApp app is configured in
// Meta's dashboard with this same value, since the verification handshake
// carries no phone_number_id to resolve a per-tenant token from.
const VERIFY_TOKEN = process.env.WA_WEBHOOK_VERIFY_TOKEN;

const STATUS_RANK = { Sent: 1, Delivered: 2, Read: 3 };
const INBOX_RANK = { sent: 1, delivered: 2, read: 3 };

const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!VERIFY_TOKEN) {
    console.error("[WA Webhook] WA_WEBHOOK_VERIFY_TOKEN is not set — refusing verification");
    return res.sendStatus(403);
  }
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WA Webhook] GET Verification successful");
    return res.status(200).send(challenge);
  }
  console.warn("[WA Webhook] GET Verification failed");
  return res.sendStatus(403);
};

const last10 = (mobile) => String(mobile || "").replace(/\D/g, "").slice(-10);

// Per-tenant signature check: a tenant that has saved an App Secret (see
// whatsapp_integration_controller.js#updateToken) gets its webhook payloads
// authenticated against Meta's X-Hub-Signature-256; a tenant that hasn't
// configured one yet is accepted as before (opt-in hardening, not a breaking
// change for existing connections).
const verifySignature = (appSecret, rawBody, signatureHeader) => {
  if (!appSecret) return true;
  if (!signatureHeader || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
};

const handleStatuses = async (statuses) => {
  for (const s of statuses) {
    const capitalized = s.status?.charAt(0).toUpperCase() + s.status?.slice(1);

    if (s.status === "failed") {
      const log = await WhatsAppCampaignLog.findOne({ message_id: s.id });
      if (log && log.status === "Sent") {
        log.status = "Failed";
        log.error = s.errors?.[0]?.title || "Delivery failed";
        await log.save();
      }
      await WhatsAppInbox.updateOne({ wa_message_id: s.id }, { delivery_status: "failed" });
      continue;
    }

    const log = await WhatsAppCampaignLog.findOne({ message_id: s.id });
    if (log && STATUS_RANK[capitalized] > (STATUS_RANK[log.status] || 0)) {
      log.status = capitalized;
      if (capitalized === "Delivered") log.delivered_at = new Date();
      if (capitalized === "Read") log.read_at = new Date();
      await log.save();
    }

    const inboxRow = await WhatsAppInbox.findOne({ wa_message_id: s.id });
    if (inboxRow && INBOX_RANK[s.status] > (INBOX_RANK[inboxRow.delivery_status] || 0)) {
      inboxRow.delivery_status = s.status;
      await inboxRow.save();
    }
  }
};

const OPT_OUT_KEYWORDS = ["stop", "unsubscribe"];

const maybeAutoReply = async (integration, tenantId, mobile) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const alreadyReplied = await WhatsAppInbox.findOne({
    tenant_id: tenantId,
    mobile,
    direction: "out",
    auto_replied: true,
    received_at: { $gte: since },
  });
  if (alreadyReplied) return;

  const businessName = process.env.BUSINESS_NAME || "our team";
  const supportPhone = process.env.SUPPORT_PHONE || "";
  const message = `Thanks for reaching out to ${businessName}! We've received your message and will get back to you shortly.${
    supportPhone ? ` For urgent queries, call ${supportPhone}.` : ""
  }`;

  const messageId = await sendWhatsAppMessage(integration, mobile, message);
  await WhatsAppInbox.create({
    tenant_id: tenantId,
    from: integration.display_phone_number || "",
    mobile,
    message,
    msg_type: "text",
    wa_message_id: messageId,
    direction: "out",
    auto_replied: true,
    delivery_status: "sent",
    received_at: new Date(),
  });
};

const handleMessages = async (integration, messages, contacts, io) => {
  const captureLeads = await tenantHasFeature(integration.tenant_id, "whatsapp_leads");

  for (const msg of messages) {
    const tenantId = integration.tenant_id;
    const mobile = last10(msg.from);
    const senderName = contacts?.find((c) => c.wa_id === msg.from)?.profile?.name || "";

    // Meta redelivers events it thinks weren't acknowledged — skip a message
    // we've already stored so it isn't counted or turned into a lead twice.
    if (msg.id && (await WhatsAppInbox.exists({ wa_message_id: msg.id, direction: "in" }))) {
      continue;
    }

    let text = "";
    let msgType = "text";
    let mediaUrl = null;

    if (msg.type === "text") {
      text = msg.text?.body || "";
    } else if (["image", "document", "audio", "video", "sticker"].includes(msg.type)) {
      msgType = msg.type;
      const mediaId = msg[msg.type]?.id;
      if (mediaId) mediaUrl = await downloadWhatsAppMedia(integration, mediaId);
      text = msg[msg.type]?.caption || "";
    } else {
      msgType = "other";
    }

    const isOptOut = OPT_OUT_KEYWORDS.includes(text.trim().toLowerCase());
    if (isOptOut) {
      await Lead.updateMany({ tenant_id: tenantId, phonenumber: { $regex: `${mobile}$` } }, { whatsapp_opt_out: true });
    }

    const receivedAt = new Date(Number(msg.timestamp) * 1000 || Date.now());
    let lead = null;
    let leadSyncError = null;
    if (isOptOut || !captureLeads) {
      lead = await Lead.findOne({ tenant_id: tenantId, phonenumber: { $regex: `${mobile}$` } }).select("_id");
    } else {
      try {
        const result = await upsertLeadFromWhatsApp({
          tenantId,
          from: msg.from,
          senderName,
          text: text || (msgType !== "text" ? `[${msgType}]` : ""),
          receivedAt,
          referral: msg.referral,
        });
        lead = result.lead;
        io?.to(`tenant-${tenantId}`).emit("lead:whatsapp", {
          leadId: String(lead._id),
          created: result.created,
          name: lead.name,
          mobile,
        });
      } catch (err) {
        leadSyncError = err.message;
        console.error(`[WA Webhook] lead sync failed tenant=${tenantId} mobile=${mobile} msg=${msg.id}:`, err.message);
      }
    }

    await WhatsAppInbox.create({
      tenant_id: tenantId,
      from: msg.from,
      mobile,
      sender_name: senderName,
      message: text,
      msg_type: msgType,
      wa_message_id: msg.id,
      media_url: mediaUrl,
      lead_id: lead?._id || null,
      direction: "in",
      received_at: receivedAt,
      lead_sync_error: leadSyncError,
    });

    await maybeAutoReply(integration, tenantId, mobile).catch((err) =>
      console.error("[WA Webhook] auto-reply failed:", err.message)
    );
  }
};

const receiveWebhook = async (req, res) => {
  // Always ack immediately — Meta retries aggressively on anything but a fast 200.
  res.status(200).send("EVENT_RECEIVED");

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  const signatureHeader = req.headers["x-hub-signature-256"];

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const integration = await WhatsAppIntegration.findOne({ phone_number_id: phoneNumberId });
        if (!integration) {
          console.warn(`[WA Webhook] No integration connected for phone_number_id ${phoneNumberId}`);
          continue;
        }

        if (!verifySignature(integration.app_secret, req.rawBody, signatureHeader)) {
          console.warn(`[WA Webhook] Signature verification failed for phone_number_id ${phoneNumberId} — payload discarded`);
          continue;
        }

        if (value.statuses?.length) await handleStatuses(value.statuses);
        if (value.messages?.length) await handleMessages(integration, value.messages, value.contacts, req.app.get("io"));
      }
    }
  } catch (err) {
    console.error("[WA Webhook] processing error:", err.message);
  }
};

module.exports = { verifyWebhook, receiveWebhook };
