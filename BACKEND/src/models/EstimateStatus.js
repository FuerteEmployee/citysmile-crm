const mongoose = require("mongoose");

const estimateStatusSchema = new mongoose.Schema(
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

estimateStatusSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const EstimateStatus = mongoose.model("EstimateStatus", estimateStatusSchema);

module.exports = EstimateStatus;
