const mongoose = require("mongoose");

/**
 * Notification — persisted, per-user in-app notification (notification center).
 * Created alongside push/email/socket delivery by notification_service.
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String, // e.g. LOW_STOCK, OUT_OF_STOCK, DEAD_STOCK, FAST_MOVING, general
      default: "general",
    },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
    },
    channel: { type: String, default: "inapp" },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
    refType: { type: String }, // e.g. "Alert"
    refId: { type: mongoose.Schema.Types.ObjectId },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store" },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = (mongoose.models["Notification"] || mongoose.model("Notification", notificationSchema));
