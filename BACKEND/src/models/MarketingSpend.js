const mongoose = require("mongoose");

// Daily marketing "burning amount" (ad spend), optionally per lead source
// and/or campaign. Leads-per-day and cost-per-lead are computed from the Lead
// collection at read time, so they always reflect real lead data.
const marketingSpendSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    // Calendar day in the app timezone (YYYY-MM-DD) — the identity of the row.
    day: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    // Start of `day` in the app timezone, for range queries.
    date: {
      type: Date,
      required: true,
    },
    source: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeadSource",
      default: null,
    },
    source_name: { type: String, default: "" },
    campaign: { type: String, trim: true, default: "" },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: { type: String, default: "" },
    // "meta_ads" rows are written by the Meta Ads sync and are read-only in
    // the CRM (Meta is the source of truth for them); "manual" rows are typed in.
    sync_source: { type: String, enum: ["manual", "meta_ads"], default: "manual" },
    synced_at: Date,
    currency: { type: String, default: "" },
    meta_campaign_ids: { type: [String], default: undefined },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  { timestamps: true }
);

marketingSpendSchema.index({ tenant_id: 1, date: 1 });
marketingSpendSchema.index({ tenant_id: 1, day: 1, source: 1, campaign: 1 }, { unique: true });

module.exports = mongoose.model("MarketingSpend", marketingSpendSchema);
