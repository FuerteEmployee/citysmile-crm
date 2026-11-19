const mongoose = require("mongoose");

const whatsAppCampaignLogSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    campaign_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppCampaign",
      required: true,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    // Set instead of lead_id when the recipient came from the Customers audience.
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    mobile: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["Sent", "Delivered", "Read", "Failed", "OptedOut"],
      default: "Sent",
    },
    // Meta's wamid.* — the webhook's delivery/read receipts are matched back to a
    // log row by this field, so it must be indexed.
    message_id: {
      type: String,
      index: true,
    },
    template_id: String,
    error: String,
    sent_at: { type: Date, default: Date.now },
    delivered_at: Date,
    read_at: Date,
  },
  {
    timestamps: true,
  }
);

whatsAppCampaignLogSchema.index({ campaign_id: 1, lead_id: 1 });
whatsAppCampaignLogSchema.index({ tenant_id: 1, createdAt: -1 });
whatsAppCampaignLogSchema.index({ campaign_id: 1, status: 1 });

const WhatsAppCampaignLog = mongoose.model("WhatsAppCampaignLog", whatsAppCampaignLogSchema);

module.exports = WhatsAppCampaignLog;
