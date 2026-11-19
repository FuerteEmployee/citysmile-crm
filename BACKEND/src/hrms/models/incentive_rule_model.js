const mongoose = require("mongoose");

const SlabEntrySchema = new mongoose.Schema(
  {
    minPct:  { type: Number, required: true, default: 0 },
    maxPct:  { type: Number, default: null },    // null = unbounded (≥ minPct)
    type:    { type: String, enum: ["percentage", "fixed"], default: "percentage" },
    value:   { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const IncentiveRuleSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    name:        { type: String, required: true },
    description: { type: String, default: "" },

    // Who this rule applies to
    appliesTo:       { type: String, enum: ["all", "role"], default: "all" },
    appliesToRoleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", default: null },

    // What this rule applies to — independent of the "who" axis above.
    // A rule is global, OR scoped to a single category, OR scoped to a single brand.
    scopeType:  { type: String, enum: ["all", "category", "brand"], default: "all" },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    brandId:    { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null },

    // Optional qualifying conditions (ignored when rewardType is 'slab')
    conditions: {
      minRevenue:      { type: Number, default: 0 },
      minMarginPercent:{ type: Number, default: 0 },
    },

    rewardType:  { type: String, enum: ["fixed", "percentage", "slab"], default: "slab" },
    rewardValue: { type: Number, default: 0 },   // used only for fixed / percentage types
    slabs:       { type: [SlabEntrySchema], default: [] }, // used only when rewardType === 'slab'

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Only one active rule may be scoped to a given category/brand at a time
// PER TENANT — keeps auto-match (by category/brand identity) deterministic
// without one tenant's scoped rule colliding with another's.
IncentiveRuleSchema.index(
  { tenant_id: 1, scopeType: 1, categoryId: 1 },
  { unique: true, partialFilterExpression: { scopeType: "category", active: true } }
);
IncentiveRuleSchema.index(
  { tenant_id: 1, scopeType: 1, brandId: 1 },
  { unique: true, partialFilterExpression: { scopeType: "brand", active: true } }
);

module.exports = (mongoose.models["IncentiveRule"] || mongoose.model("IncentiveRule", IncentiveRuleSchema));
