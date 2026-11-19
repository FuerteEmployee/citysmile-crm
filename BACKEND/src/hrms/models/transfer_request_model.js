const mongoose = require("mongoose");

const transferRequestSchema = new mongoose.Schema(
  {
    fromBranch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    toBranch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemMaster",
      required: true,
    },
    quantity: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected", "InTransit", "Completed"],
      default: "Pending",
    },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// Optimized indexes — status and createdAt single-field removed (covered by compound)
transferRequestSchema.index({ fromBranch: 1 });
transferRequestSchema.index({ toBranch: 1 });
transferRequestSchema.index({ status: 1, createdAt: -1 }); // covers status-only queries + sort

module.exports = (mongoose.models["TransferRequest"] || mongoose.model("TransferRequest", transferRequestSchema));
