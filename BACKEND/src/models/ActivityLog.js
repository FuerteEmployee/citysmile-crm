const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    staffid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
    },
    rel_type: {
      type: String, // 'invoice', 'estimate', 'project', etc.
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

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);

module.exports = ActivityLog;
