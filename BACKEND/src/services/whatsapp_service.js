const axios = require("axios");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Every send/upload/download call is scoped to one tenant's connected number —
// unlike the old single-tenant design (one shared WA_LIVE/WA_ACCESS_TOKEN env
// pair), safe-mode is now per-integration (`integration.is_live`), so one
// tenant going live never risks another tenant's leads getting real messages.
const getActiveIntegration = async (tenantId, phoneNumberId) => {
  const query = phoneNumberId
    ? { tenant_id: tenantId, phone_number_id: phoneNumberId }
    : { tenant_id: tenantId };
  return WhatsAppIntegration.findOne(query).sort({ createdAt: 1 });
};

// Normalizes a 10-digit Indian mobile (or one already carrying "91"/"+91")
// into the bare "91XXXXXXXXXX" shape the Graph API's `to` field expects (no "+").
// Leading zeros (trunk prefix "0", or "00" before a country code) are dropped
// first, so "09876543210" and "0091 98765 43210" both become "919876543210".
const toWaNumber = (mobile) => {
  const digits = String(mobile || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const sendTemplateMessage = async (integration, mobile, template, bodyParams = [], imageUrl = null, languageCode = null) => {
  const to = toWaNumber(mobile);
  if (!integration || !integration.is_live) {
    console.log(`[WA SAFE MODE] template "${template}" -> ${to}`, bodyParams);
    return { success: true, skipped: true, messageId: `SIMULATED-${Date.now()}` };
  }

  const components = [];
  if (imageUrl) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: imageUrl } }] });
  }
  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map((text) => ({
        type: "text",
        text: (text !== null && text !== undefined && String(text).trim() !== "") ? String(text).trim() : "-",
      })),
    });
  }

  const lang = languageCode || "en_US";

  const trySendWithLang = async (code) => {
    return axios.post(
      `${GRAPH_API_BASE}/${integration.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code },
          ...(components.length > 0 ? { components } : {}),
        },
      },
      { headers: { Authorization: `Bearer ${integration.access_token}` } }
    );
  };

  try {
    let response;
    try {
      response = await trySendWithLang(lang);
    } catch (firstErr) {
      const isTranslationErr = firstErr.response?.data?.error?.code === 132001 ||
        firstErr.response?.data?.error?.message?.includes("Template name does not exist in the translation");
      if (isTranslationErr && lang !== "en_US") {
        response = await trySendWithLang("en_US");
      } else if (isTranslationErr && lang !== "en") {
        response = await trySendWithLang("en");
      } else {
        throw firstErr;
      }
    }
    return { success: true, messageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    const fbMessage = error.response?.data?.error?.message;
    console.error("[WA] sendTemplateMessage error:", JSON.stringify(error.response?.data || error.message));
    return { success: false, error: fbMessage || error.message };
  }
};

// Free-text/media send — only works inside Meta's 24h customer-service window.
// Returns { success, messageId, error } so callers can tell the user why a
// send failed instead of recording it as sent.
const sendWhatsAppMessageResult = async (integration, mobile, message, mediaUrl = null, msgType = "text") => {
  const to = toWaNumber(mobile);
  if (!integration || !integration.is_live) {
    console.log(`[WA SAFE MODE] ${msgType} -> ${to}: ${message}`);
    return { success: true, skipped: true, messageId: `SIMULATED-${Date.now()}` };
  }

  const payload = { messaging_product: "whatsapp", to };
  if (mediaUrl && msgType !== "text") {
    payload.type = msgType;
    payload[msgType] = { link: mediaUrl, ...(msgType === "document" ? { filename: "document.pdf" } : {}) };
  } else {
    payload.type = "text";
    payload.text = { body: message };
  }

  try {
    const response = await axios.post(`${GRAPH_API_BASE}/${integration.phone_number_id}/messages`, payload, {
      headers: { Authorization: `Bearer ${integration.access_token}` },
    });
    return { success: true, messageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    console.error("[WA] sendWhatsAppMessage error:", JSON.stringify(error.response?.data || error.message));
    const fb = error.response?.data?.error;
    // 131047 = outside the 24h window: only a template can reach this person now.
    const outsideWindow = fb?.code === 131047;
    return {
      success: false,
      outsideWindow,
      error: outsideWindow
        ? "The 24-hour reply window has closed. Send an approved template instead."
        : fb?.message || error.message,
    };
  }
};

const graphError = (error) => {
  const fb = error.response?.data?.error;
  const outsideWindow = fb?.code === 131047;
  return {
    success: false,
    outsideWindow,
    error: outsideWindow
      ? "The 24-hour reply window has closed. Send an approved template instead."
      : fb?.message || error.message,
  };
};

// A PDF with its real file name (sendWhatsAppMessageResult always names it
// document.pdf). Inside the 24h window only.
const sendDocumentMessage = async (integration, mobile, documentUrl, filename, caption = "") => {
  const to = toWaNumber(mobile);
  if (!integration || !integration.is_live) {
    console.log(`[WA SAFE MODE] document ${filename} -> ${to}`);
    return { success: true, skipped: true, messageId: `SIMULATED-${Date.now()}` };
  }
  try {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${integration.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { link: documentUrl, filename, ...(caption ? { caption } : {}) },
      },
      { headers: { Authorization: `Bearer ${integration.access_token}` } }
    );
    return { success: true, messageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    console.error("[WA] sendDocumentMessage error:", JSON.stringify(error.response?.data || error.message));
    return graphError(error);
  }
};

// An approved template whose header is a DOCUMENT — the only way to send a
// PDF outside the 24h window.
const sendDocumentTemplate = async (integration, mobile, template, languageCode, documentUrl, filename, bodyParams = []) => {
  const to = toWaNumber(mobile);
  if (!integration || !integration.is_live) {
    console.log(`[WA SAFE MODE] template "${template}" with document ${filename} -> ${to}`, bodyParams);
    return { success: true, skipped: true, messageId: `SIMULATED-${Date.now()}` };
  }
  const components = [{ type: "header", parameters: [{ type: "document", document: { link: documentUrl, filename } }] }];
  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map((text) => ({ type: "text", text: String(text ?? "").trim() || "-" })),
    });
  }
  try {
    const response = await axios.post(
      `${GRAPH_API_BASE}/${integration.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: template, language: { code: languageCode || "en" }, components },
      },
      { headers: { Authorization: `Bearer ${integration.access_token}` } }
    );
    return { success: true, messageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    console.error("[WA] sendDocumentTemplate error:", JSON.stringify(error.response?.data || error.message));
    return graphError(error);
  }
};

// Older callers (webhook auto-reply) only need the message id, or null on failure.
const sendWhatsAppMessage = async (...args) => {
  const result = await sendWhatsAppMessageResult(...args);
  return result.success ? result.messageId : null;
};

// Re-hosts an inbound media attachment (Meta's media URLs expire) onto
// Cloudinary via the same upload helper the rest of the CRM already reuses
// (see src/routes/staff_routes.js for the precedent of requiring this
// HRMS-owned module from outside src/hrms).
const downloadWhatsAppMedia = async (integration, mediaId) => {
  try {
    const metaRes = await axios.get(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${integration.access_token}` },
    });
    const mediaUrl = metaRes.data?.url;
    if (!mediaUrl) return null;

    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${integration.access_token}` },
      responseType: "arraybuffer",
    });

    const upload = require("../hrms/utils/cloudinary_config");
    return await upload.uploadToCloudinary(
      { buffer: Buffer.from(fileRes.data), originalname: `wa-${mediaId}.jpg` },
      "whatsapp_inbox"
    );
  } catch (error) {
    console.error("[WA] downloadWhatsAppMedia error:", error.message);
    return null;
  }
};

module.exports = {
  GRAPH_API_BASE,
  getActiveIntegration,
  toWaNumber,
  sendTemplateMessage,
  sendWhatsAppMessage,
  sendWhatsAppMessageResult,
  sendDocumentMessage,
  sendDocumentTemplate,
  downloadWhatsAppMedia,
};
