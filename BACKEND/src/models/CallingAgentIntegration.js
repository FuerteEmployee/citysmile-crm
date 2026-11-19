const mongoose = require("mongoose");

// Mirrors MetaIntegration.js's shape and reasoning: one document per
// virtual number (not per tenant), since the webhook receiver has no
// session/auth context to know which tenant is calling — it resolves the
// tenant purely from data attached to the request itself.
const callingAgentIntegrationSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    virtual_number: {
      type: String,
      required: true,
    },
    virtual_number_e164: {
      type: String,
      index: true,
    },
    provider: {
      type: String,
      enum: ["exotel"],
      default: "exotel",
    },
    // Secret path segment embedded in the webhook URLs registered with
    // Exotel. Exotel has no HMAC-signature mechanism for these webhooks
    // (confirmed against their docs — Connect Applet calls are unsigned
    // GET requests), so this token is what stands in for one: the lookup
    // by webhook_token IS the authenticity check, since an attacker who
    // doesn't know it can't produce a matching integration document.
    // Never logged, never returned in any API response.
    webhook_token: {
      type: String,
      required: true,
      unique: true,
    },
    // Where to bridge a call when there's no assigned staff member, or the
    // match is ambiguous and there's no single obviously-correct target.
    default_fallback_number: {
      type: String,
    },
    consent_announcement_text: {
      type: String,
      default: "This call may be recorded for quality and training purposes.",
    },
    active: {
      type: Boolean,
      default: true,
    },
    connected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

const CallingAgentIntegration = mongoose.model(
  "CallingAgentIntegration",
  callingAgentIntegrationSchema
);

module.exports = CallingAgentIntegration;
