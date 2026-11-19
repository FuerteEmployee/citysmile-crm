const mongoose = require("mongoose");

// Mirrors MetaIntegration.js's shape and reasoning: one document per WhatsApp
// phone number (not per tenant), since the public webhook has no session/auth
// context and must resolve the tenant purely from `phone_number_id` in the
// payload it receives from Meta. A tenant can connect more than one number.
const whatsAppIntegrationSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    phone_number_id: {
      type: String,
      required: true,
      unique: true,
    },
    waba_id: {
      // WhatsApp Business Account ID — needed to list approved templates.
      type: String,
      required: true,
    },
    display_phone_number: String,
    access_token: {
      type: String,
      required: true,
    },
    // Optional per-tenant Meta App Secret — enables real X-Hub-Signature-256
    // verification on the shared webhook (see whatsapp_webhook_controller.js).
    // Left unset, the webhook accepts this tenant's events without checking
    // the signature, same as before this field existed.
    app_secret: {
      type: String,
    },
    // Optional Meta App ID. Together with app_secret, lets connect() register
    // this app's webhook subscription automatically via the Graph API instead
    // of requiring a manual "Verify and save" in Meta's dashboard for every
    // new tenant's Meta App (see registerWebhookSubscription in
    // whatsapp_integration_controller.js). Left unset, connecting still works
    // exactly as before — the webhook just has to be registered manually.
    app_id: {
      type: String,
    },
    // Set when registerWebhookSubscription last succeeded/failed for this
    // connection, surfaced in the Connect Account UI so a failure isn't silent.
    webhook_registered: {
      type: Boolean,
      default: false,
    },
    webhook_registration_error: {
      type: String,
    },
    // Per-tenant safe/live toggle — mirrors the old single-tenant WA_LIVE env
    // var, but scoped per connected number so one tenant going live never
    // affects another's.
    is_live: {
      type: Boolean,
      default: false,
    },
    connected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    last_synced: Date,
  },
  {
    timestamps: true,
  }
);

const WhatsAppIntegration = mongoose.model("WhatsAppIntegration", whatsAppIntegrationSchema);

module.exports = WhatsAppIntegration;
