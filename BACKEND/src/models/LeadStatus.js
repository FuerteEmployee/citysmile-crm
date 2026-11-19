const mongoose = require("mongoose");

const leadStatusSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    statusorder: {
      type: Number,
      default: 0,
    },
    color: {
      type: String,
      default: "#757575",
    },
    isdefault: {
      type: Number,
      default: 0,
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

leadStatusSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const LeadStatus = mongoose.model("LeadStatus", leadStatusSchema);

module.exports = LeadStatus;
