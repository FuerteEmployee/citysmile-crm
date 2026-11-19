const mongoose = require("mongoose");

const DeviceApprovalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    requestedDeviceId: {
      type: String,
      required: true,
    },
    deviceInfo: {
      userAgent: String,
      platform: String,
      deviceName: String,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "revoked"],
      default: "pending",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["DeviceApproval"] || mongoose.model("DeviceApproval", DeviceApprovalSchema));
