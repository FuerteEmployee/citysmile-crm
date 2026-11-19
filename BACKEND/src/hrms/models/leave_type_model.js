const mongoose = require("mongoose");

const LeaveTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String, // e.g., Sick Leave, Casual Leave
      required: true,
      trim: true,
    },
    code: {
      type: String, // e.g., SL, CL, PL, LWP
      required: true,
      uppercase: true,
      trim: true,
    },
    // null = a shared default every company sees (the auto-seeded SL/CL/EL/PL);
    // otherwise the company that created it — only that company sees it.
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
    isPaid: {
      type: Boolean,
      default: true,
    },
    yearlyQuota: {
      type: Number,
      default: 0,
    },
    carryForward: {
      type: Boolean,
      default: false,
    },
    requiresAttachment: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  // autoIndex off: this index replaces the old global code_1 unique index and is
  // built by scripts/migrate-leavetype-expcat-tenant.js (run per database with
  // approval) — not silently by whichever server starts first.
  { timestamps: true, autoIndex: false }
);

LeaveTypeSchema.index({ tenant_id: 1, code: 1 }, { unique: true, name: "tenant_id_1_code_1" });

module.exports = (mongoose.models["LeaveType"] || mongoose.model("LeaveType", LeaveTypeSchema));
