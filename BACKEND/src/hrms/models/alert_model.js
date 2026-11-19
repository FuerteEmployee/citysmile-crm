const mongoose = require("mongoose");

/**
 * Alert — a first-class, deduplicated stock alert (MODULE 3, Automated Reorder).
 * One active alert per (type, productId, branchId) is kept open so the daily job
 * and the realtime hook don't create duplicates or spam notifications.
 */
const ALERT_TYPES = ["LOW_STOCK", "OUT_OF_STOCK", "DEAD_STOCK", "FAST_MOVING"];

const alertSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ALERT_TYPES, required: true, index: true },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "warning",
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ItemMaster",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "acknowledged", "resolved", "snoozed"],
      default: "open",
      index: true,
    },
    message: { type: String, default: "" },

    // Snapshot fields for the alerts panel
    currentQty: { type: Number },
    available: { type: Number },
    reorderLevel: { type: Number },

    // Predictive / actionable fields
    suggestedAction: { type: String, default: "" }, // dead stock: transfer/discount/return
    suggestedReorderQty: { type: Number },
    avgDailySales: { type: Number },
    daysUntilStockout: { type: Number },
    projectedStockoutDate: { type: Date },
    lastSoldDate: { type: Date },

    // Workflow
    snoozedUntil: { type: Date },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    acknowledgedAt: { type: Date },
    resolvedAt: { type: Date },

    // Notification throttling
    lastNotifiedAt: { type: Date },
    notifyCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Dedup / fast lookup of the active alert for a product at a branch.
alertSchema.index({ type: 1, productId: 1, branchId: 1, status: 1 });
alertSchema.index({ branchId: 1, status: 1, createdAt: -1 });

module.exports = (mongoose.models["Alert"] || mongoose.model("Alert", alertSchema));
module.exports.ALERT_TYPES = ALERT_TYPES;
