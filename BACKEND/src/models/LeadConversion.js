const mongoose = require("mongoose");

// One record per converted lead: the lead → patient (Client) conversion and
// the treatment business it produced. Treatment totals on the Leads page are
// aggregated from these rows, never from user-entered summary numbers.
const leadConversionSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
    converted_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    converted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    treatment_item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
    },
    treatment_name: {
      type: String,
      required: true,
      trim: true,
    },
    treatment_amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Snapshots taken at conversion time so reports stay correct even if the
    // lead's source/campaign/assignee is edited or deleted later.
    source: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeadSource",
    },
    source_name: { type: String, default: "" },
    campaign: { type: String, default: "" },
    is_whatsapp: { type: Boolean, default: false },
    assigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

leadConversionSchema.index({ tenant_id: 1, lead: 1 }, { unique: true });

module.exports = mongoose.model("LeadConversion", leadConversionSchema);
