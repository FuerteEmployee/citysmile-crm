const mongoose = require("mongoose");

// One audience-rule set per (tenant, template). include_statuses/exclude_statuses
// store LeadStatus *names* (not ids) since LeadStatus is itself a free-form,
// tenant-scoped, admin-editable list rather than a fixed enum — the controller
// resolves these names to LeadStatus ids for that tenant at query time.
const whatsAppTemplateConditionSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    template_id: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      default: "",
    },
    recency_days: {
      // 0 = no limit
      type: Number,
      default: 0,
      min: 0,
    },
    frequency_cap: {
      max_messages: { type: Number, default: 0, min: 0 }, // 0 = no cap
      period_days: { type: Number, default: 30, min: 1 },
    },
    match_category: {
      type: Boolean,
      default: false,
    },
    exclude_statuses: {
      type: [String],
      default: [],
    },
    // Wins over exclude_statuses when non-empty
    include_statuses: {
      type: [String],
      default: [],
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

whatsAppTemplateConditionSchema.index({ tenant_id: 1, template_id: 1 }, { unique: true });

const WhatsAppTemplateCondition = mongoose.model("WhatsAppTemplateCondition", whatsAppTemplateConditionSchema);

module.exports = WhatsAppTemplateCondition;
