// One-time helper: connects the WhatsApp number in .env (WA_PHONE_NUMBER_ID,
// WA_BUSINESS_ACCOUNT_ID, WA_ACCESS_TOKEN, WA_APP_ID, WA_APP_SECRET, WA_LIVE)
// to a tenant — the same thing the "Connect" button in WhatsApp Integration
// settings does (see connect() in whatsapp_integration_controller.js).
//
// The backend never reads these WA_* vars at runtime: incoming webhooks
// resolve the tenant from the WhatsAppIntegration document by
// phone_number_id, so the number has to be saved there to work.
//
// Usage:
//   node connect-whatsapp-from-env.js                 -> verify with Meta + list tenants
//   node connect-whatsapp-from-env.js <tenantId>      -> verify, then save for that tenant
require("dotenv").config();
// Same DNS override as index.js — the local resolver refuses Atlas SRV lookups.
require("dns").setServers(["8.8.8.8", "1.1.1.1"]);
const axios = require("axios");
const mongoose = require("mongoose");
const WhatsAppIntegration = require("./src/models/WhatsAppIntegration");

const GRAPH_API_BASE = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || "v21.0"}`;

const env = (k) => String(process.env[k] || "").trim();

(async () => {
  const phone_number_id = env("WA_PHONE_NUMBER_ID");
  const waba_id = env("WA_BUSINESS_ACCOUNT_ID");
  const access_token = env("WA_ACCESS_TOKEN");
  const app_id = env("WA_APP_ID");
  const app_secret = env("WA_APP_SECRET");
  const is_live = env("WA_LIVE").toLowerCase() === "true";
  const tenantId = process.argv[2];

  if (!phone_number_id || !waba_id || !access_token) {
    throw new Error("WA_PHONE_NUMBER_ID, WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN must be set in .env");
  }

  let display_phone_number;
  try {
    const { data } = await axios.get(`${GRAPH_API_BASE}/${phone_number_id}`, {
      params: { access_token, fields: "display_phone_number,verified_name" },
    });
    display_phone_number = data.display_phone_number;
    console.log(`Meta OK: ${data.verified_name || ""} ${display_phone_number}`);
  } catch (err) {
    throw new Error(`Meta rejected Phone Number ID/Token: ${err.response?.data?.error?.message || err.message}`);
  }

  await mongoose.connect(process.env.MONGO_URI);

  if (!tenantId) {
    const tenants = await mongoose.connection.db
      .collection("tenants")
      .find({})
      .project({ name: 1, company_name: 1 })
      .toArray();
    console.log("\nTenants (re-run with the City Smile _id):");
    tenants.forEach((t) => console.log(`  ${t._id}  ${t.name || t.company_name || ""}`));
    return;
  }

  const existing = await WhatsAppIntegration.findOne({ phone_number_id });
  if (existing && String(existing.tenant_id) !== tenantId) {
    throw new Error(`This number is already connected to another tenant (${existing.tenant_id}).`);
  }

  // Webhook auto-registration needs BACKEND_PUBLIC_URL; same non-fatal
  // behaviour as registerWebhookSubscription() in the controller.
  let webhook_registered = false;
  let webhook_registration_error = "";
  const publicUrl = env("BACKEND_PUBLIC_URL");
  if (!publicUrl) {
    webhook_registration_error = "BACKEND_PUBLIC_URL is not configured — register the webhook manually in Meta.";
  } else if (app_id && app_secret) {
    try {
      await axios.post(`${GRAPH_API_BASE}/${app_id}/subscriptions`, null, {
        params: {
          object: "whatsapp_business_account",
          callback_url: `${publicUrl.replace(/\/$/, "")}/api/webhooks/whatsapp`,
          verify_token: env("WA_WEBHOOK_VERIFY_TOKEN") || "rudraverse_crm_whatsapp_2026",
          fields: "messages",
          access_token: `${app_id}|${app_secret}`,
        },
      });
      webhook_registered = true;
    } catch (err) {
      webhook_registration_error = err.response?.data?.error?.message || err.message;
    }
  }

  // The WABA must also subscribe the app, or Meta delivers no messages to the
  // webhook (see subscribeWabaToApp in whatsapp_integration_controller.js).
  try {
    await axios.post(`${GRAPH_API_BASE}/${waba_id}/subscribed_apps`, null, { params: { access_token } });
  } catch (err) {
    webhook_registered = false;
    const msg = err.response?.data?.error?.message || err.message;
    webhook_registration_error = [webhook_registration_error, `subscribed_apps: ${msg}`].filter(Boolean).join(" | ");
  }

  const integration = await WhatsAppIntegration.findOneAndUpdate(
    { phone_number_id },
    {
      tenant_id: tenantId,
      phone_number_id,
      waba_id,
      display_phone_number,
      access_token,
      ...(app_secret ? { app_secret } : {}),
      ...(app_id ? { app_id } : {}),
      is_live,
      webhook_registered,
      webhook_registration_error,
      last_synced: new Date(),
    },
    { upsert: true, new: true }
  );

  console.log(`Saved WhatsApp integration ${integration._id} for tenant ${tenantId} (live: ${is_live})`);
  console.log(webhook_registered ? "Webhook registered with Meta." : `Webhook NOT registered: ${webhook_registration_error}`);
})()
  .catch((err) => {
    console.error("Error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
