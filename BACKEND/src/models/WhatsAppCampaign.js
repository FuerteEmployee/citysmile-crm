const mongoose = require("mongoose");

const whatsAppCampaignSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    template_id: {
      // Meta-approved template name (not an ObjectId — templates live in Meta, not our DB)
      type: String,
      required: true,
    },
    image_media_url: {
      type: String,
      default: null,
    },
    template_params: {
      type: Object,
      default: {},
    },
    // Free-text filter matched against Lead.tags when audience_source === "leads"
    target_audience: {
      type: String,
      default: "",
      trim: true,
    },
    // leads          = live Lead query (tag/status/source filters below)
    // selected_leads = only the leads picked in lead_ids
    // customers      = active customers (all, or only customer_ids)
    // upload         = the fixed `recipients` list (typed in or from a sheet)
    audience_source: {
      type: String,
      enum: ["leads", "selected_leads", "customers", "upload"],
      default: "leads",
    },
    lead_status_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "LeadStatus" }],
    lead_source_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "LeadSource" }],
    lead_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    // Empty = every active customer of the tenant.
    customer_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Client" }],
    recipients: [
      {
        name: String,
        mobile: { type: String, required: true },
      },
    ],
    status: {
      type: String,
      enum: ["Draft", "Scheduled", "InProgress", "Completed", "Failed", "Cancelled"],
      default: "Draft",
    },
    stop_requested: {
      type: Boolean,
      default: false,
    },
    sent_count: {
      type: Number,
      default: 0,
    },
    // Explicit boolean instead of matching a magic `type === "Educational Content"`
    // string (as the original Screen Time design did) — a recurring campaign is put
    // back to "Scheduled" (not "Completed") after each clean monthly run so it fires again.
    recurring: {
      type: Boolean,
      default: false,
    },
    scheduled_at: Date,
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

whatsAppCampaignSchema.index({ tenant_id: 1, status: 1 });
whatsAppCampaignSchema.index({ tenant_id: 1, recurring: 1, status: 1 });

const WhatsAppCampaign = mongoose.model("WhatsAppCampaign", whatsAppCampaignSchema);

module.exports = WhatsAppCampaign;
