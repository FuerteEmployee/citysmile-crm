const mongoose = require("mongoose");

const leadSourceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

leadSourceSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const LeadSource = mongoose.model("LeadSource", leadSourceSchema);

module.exports = LeadSource;
