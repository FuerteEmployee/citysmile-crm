const axios = require("axios");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const maskToken = (token) => {
  if (!token) return "";
  if (token.length <= 8) return "••••••••";
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
};

const serialize = (integration) => ({
  _id: integration._id,
  phone_number_id: integration.phone_number_id,
  waba_id: integration.waba_id,
  display_phone_number: integration.display_phone_number,
  access_token_masked: maskToken(integration.access_token),
  app_secret_configured: !!integration.app_secret,
  app_id: integration.app_id || "",
  webhook_registered: integration.webhook_registered || false,
  webhook_registration_error: integration.webhook_registration_error || "",
  is_live: integration.is_live,
  last_synced: integration.last_synced,
});

// Registers this Meta App's webhook subscription automatically via the Graph
// API — the same thing "Verify and save" does by hand in Meta's dashboard
// (Webhooks > Whatsapp Business Account). Requires BACKEND_PUBLIC_URL to be
// set (the same value used as the Callback URL when doing this manually), and
// the App ID + App Secret together to form Meta's App Access Token
// ("{app-id}|{app-secret}", Meta's documented format for app-level calls).
// Non-fatal by design — connect()/updateToken() must not fail just because
// this automatic step didn't work; the tenant can still register it manually
// as before, same fallback this whole feature exists to skip.
const registerWebhookSubscription = async (appId, appSecret) => {
  const publicUrl = process.env.BACKEND_PUBLIC_URL;
  const verifyToken = process.env.WA_WEBHOOK_VERIFY_TOKEN;
  if (!publicUrl) {
    return { ok: false, error: "BACKEND_PUBLIC_URL is not configured on this server — cannot auto-register the webhook." };
  }
  try {
    await axios.post(`${GRAPH_API_BASE}/${appId}/subscriptions`, null, {
      params: {
        object: "whatsapp_business_account",
        callback_url: `${publicUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`,
        verify_token: verifyToken,
        fields: "messages",
        access_token: `${appId}|${appSecret}`,
      },
    });
    return { ok: true };
  } catch (apiErr) {
    const fbMessage = apiErr.response?.data?.error?.message;
    console.error("[WA] Auto webhook registration failed:", JSON.stringify(apiErr.response?.data || apiErr.message));
    return { ok: false, error: fbMessage || "Meta rejected the automatic webhook registration." };
  }
};

// The app-level subscription above only sets the callback URL; Meta still
// delivers nothing for a WABA until the WABA itself subscribes the app
// (POST /{waba-id}/subscribed_apps, with the business/system-user token).
// Without this, the webhook stays silent and no WhatsApp leads are created.
// Idempotent and non-fatal, same as registerWebhookSubscription.
const subscribeWabaToApp = async (wabaId, accessToken) => {
  try {
    await axios.post(`${GRAPH_API_BASE}/${wabaId}/subscribed_apps`, null, {
      params: { access_token: accessToken },
    });
    return { ok: true };
  } catch (apiErr) {
    const fbMessage = apiErr.response?.data?.error?.message;
    console.error("[WA] WABA subscribed_apps failed:", JSON.stringify(apiErr.response?.data || apiErr.message));
    return { ok: false, error: fbMessage || "Meta rejected subscribing the WhatsApp Business Account to this app." };
  }
};

// Combines both registration steps into the single webhook_registered flag.
const registerWebhook = async ({ app_id, app_secret, waba_id, access_token }) => {
  const subResult = await subscribeWabaToApp(waba_id, access_token);
  const appResult = app_id && app_secret ? await registerWebhookSubscription(app_id, app_secret) : { ok: false };
  const errors = [appResult.error, subResult.error].filter(Boolean);
  return { ok: appResult.ok && subResult.ok, error: errors.join(" | ") };
};

// A tenant can connect several numbers at once, so this returns the full list.
const getIntegrations = async (req, res) => {
  try {
    const integrations = await WhatsAppIntegration.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: 1 });
    res.json({ connections: integrations.map(serialize) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const connect = async (req, res) => {
  try {
    const { phone_number_id, waba_id, access_token, app_secret, app_id } = req.body;
    if (!phone_number_id || !waba_id || !access_token) {
      return res.status(400).json({ message: "Phone Number ID, WhatsApp Business Account ID and Access Token are required" });
    }

    const existing = await WhatsAppIntegration.findOne({ phone_number_id });
    if (existing && String(existing.tenant_id) !== String(req.user.tenant_id)) {
      return res.status(409).json({ message: "This WhatsApp number is already connected to a different account." });
    }

    let displayPhoneNumber;
    try {
      const verifyRes = await axios.get(`${GRAPH_API_BASE}/${phone_number_id}`, {
        params: { access_token, fields: "display_phone_number" },
      });
      displayPhoneNumber = verifyRes.data.display_phone_number;
    } catch (apiErr) {
      const fbMessage = apiErr.response?.data?.error?.message;
      console.error("[WA] Phone number verify error:", JSON.stringify(apiErr.response?.data));
      return res.status(400).json({
        message: fbMessage
          ? `Meta rejected this Phone Number ID/Token: ${fbMessage}`
          : "Could not verify Phone Number ID and Access Token with Meta. Please check both values.",
      });
    }

    // Auto-register the webhook subscription when both App ID and App Secret
    // are given — saves the tenant from doing "Verify and save" by hand in
    // Meta's dashboard. Runs before saving so the result can be stored
    // alongside the connection; failure here never blocks the connection
    // itself (see registerWebhookSubscription's own comment).
    const webhookResult = await registerWebhook({ app_id, app_secret, waba_id, access_token });

    const integration = await WhatsAppIntegration.findOneAndUpdate(
      { phone_number_id },
      {
        tenant_id: req.user.tenant_id,
        phone_number_id,
        waba_id,
        display_phone_number: displayPhoneNumber,
        access_token,
        ...(app_secret ? { app_secret } : {}),
        ...(app_id ? { app_id } : {}),
        webhook_registered: webhookResult.ok,
        webhook_registration_error: webhookResult.ok ? "" : (webhookResult.error || ""),
        connected_by: req.user._id,
        last_synced: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json(serialize(integration));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Lets a tenant rotate its Access Token (temporary → permanent, or a renewed
// permanent token) and/or set its App Secret without disconnecting and
// re-adding the number — campaigns, inbox history and audience rules attached
// to this connection stay intact.
const updateToken = async (req, res) => {
  try {
    const integration = await WhatsAppIntegration.findOne({
      tenant_id: req.user.tenant_id,
      _id: req.params.id,
    });
    if (!integration) return res.status(404).json({ message: "This number isn't connected to your account" });

    const { access_token, app_secret, app_id } = req.body;
    if (!access_token && !app_secret && !app_id) {
      return res.status(400).json({ message: "Provide a new Access Token, App Secret or App ID to update" });
    }

    if (access_token) {
      try {
        await axios.get(`${GRAPH_API_BASE}/${integration.phone_number_id}`, {
          params: { access_token, fields: "display_phone_number" },
        });
      } catch (apiErr) {
        const fbMessage = apiErr.response?.data?.error?.message;
        return res.status(400).json({
          message: fbMessage
            ? `Meta rejected this Access Token: ${fbMessage}`
            : "Could not verify the new Access Token with Meta.",
        });
      }
      integration.access_token = access_token;
      integration.last_synced = new Date();
    }

    if (app_secret) integration.app_secret = app_secret;
    if (app_id) integration.app_id = app_id;

    // Retry auto-registration once we have both pieces — covers a tenant who
    // connected without them and added App ID/Secret afterward via "Update Token".
    if (access_token || ((app_secret || app_id) && integration.app_id && integration.app_secret)) {
      const webhookResult = await registerWebhook(integration);
      integration.webhook_registered = webhookResult.ok;
      integration.webhook_registration_error = webhookResult.ok ? "" : (webhookResult.error || "");
    }

    await integration.save();
    res.json(serialize(integration));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Real message sends stay in safe/simulate mode until an admin explicitly
// flips this per connected number — mirrors the old WA_LIVE env var, but
// scoped per tenant instead of shared across every tenant on the CRM.
const setLiveMode = async (req, res) => {
  try {
    const integration = await WhatsAppIntegration.findOneAndUpdate(
      { tenant_id: req.user.tenant_id, _id: req.params.id },
      { is_live: !!req.body.is_live },
      { new: true }
    );
    if (!integration) return res.status(404).json({ message: "This number isn't connected to your account" });
    res.json(serialize(integration));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const disconnect = async (req, res) => {
  try {
    const deleted = await WhatsAppIntegration.findOneAndDelete({
      tenant_id: req.user.tenant_id,
      _id: req.params.id,
    });
    if (!deleted) return res.status(404).json({ message: "This number isn't connected to your account" });
    res.json({ message: "WhatsApp number disconnected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getIntegrations, connect, updateToken, setLiveMode, disconnect };
