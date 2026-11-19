const mongoose = require("mongoose");

// A Meta (Facebook/Instagram) ad account a tenant has connected so its daily
// ad spend can be synced into MarketingSpend. Each tenant connects its own
// accounts with its own token. An agency ad account that runs ads for several
// clients can be connected by each of those tenants, each one narrowed to its
// own Facebook Page(s) via page_ids.
const metaAdAccountSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    // Numeric id without the "act_" prefix.
    ad_account_id: {
      type: String,
      required: true,
      match: /^\d{5,25}$/,
    },
    // Only count campaigns whose ad sets promote one of these Facebook Pages.
    // Empty = the whole ad account belongs to this tenant.
    page_ids: { type: [String], default: [] },
    name: { type: String, default: "" },
    currency: { type: String, default: "" },
    timezone_name: { type: String, default: "" },
    // AES-256-GCM encrypted (src/utils/secretBox.js) — never returned by the API.
    access_token_enc: { type: String, required: true, select: false },
    token_hint: { type: String, default: "" },
    is_active: { type: Boolean, default: true },
    connected_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    last_synced_at: Date,
    last_sync_status: { type: String, enum: ["never", "ok", "error"], default: "never" },
    last_sync_error: { type: String, default: "" },
  },
  { timestamps: true }
);

metaAdAccountSchema.index({ tenant_id: 1, ad_account_id: 1 }, { unique: true });

module.exports = mongoose.model("MetaAdAccount", metaAdAccountSchema);
