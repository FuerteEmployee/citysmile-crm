const mongoose = require("mongoose");

const ShiftSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
    startTime: {
      type: String, // e.g., "09:00"
      required: true,
    },
    endTime: {
      type: String, // e.g., "18:00"
      required: true,
    },
    lateGraceMinutes: {
      type: Number,
      default: 15,
    },
    allowedLateCountPerMonth: {
      type: Number,
      default: 3,
    },
    workingDays: {
      type: [String],
      default: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    },
    overtimeGraceMinutes: {
      type: Number,
      default: 30,
    },
    // Grace before a punch-out counts as "early out". Punching out more than
    // this many minutes before shift end sets attendance.earlyOutMinutes.
    earlyOutGraceMinutes: {
      type: Number,
      default: 15,
    },
    overtimeRatePerHour: {
      type: Number,
      default: 0,
    },

    // ── Lunch break configuration (per shift, admin-configurable) ──────────
    // Two modes, admin's choice:
    //   fixed_window     — lunch is a fixed clock window (e.g. 13:00–14:00)
    //   flexible_duration— a fixed length (e.g. 60 min) taken any time in shift
    // deduction:
    //   auto  — the configured lunch length is ALWAYS subtracted from worked
    //           hours (employees need not punch lunch)
    //   punch — the employee's ACTUAL lunch-in/out punch is subtracted, but
    //           never less than the configured length: max(actual, configured).
    //           A longer lunch costs its full time; a shorter one still costs
    //           the configured minimum (NOT capped at the configured length).
    // The subtracted minutes reduce worked hours before Full/Half is decided.
    lunch: {
      enabled: { type: Boolean, default: false },
      mode: {
        type: String,
        enum: ["fixed_window", "flexible_duration"],
        default: "flexible_duration",
      },
      startTime: { type: String, default: "13:00" }, // fixed_window only
      endTime: { type: String, default: "14:00" },   // fixed_window only
      durationMinutes: { type: Number, default: 60 }, // flexible_duration
      deduction: {
        type: String,
        enum: ["auto", "punch"],
        default: "auto",
      },
    },

    // ── Reminder / notification configuration (per shift) ──────────────────
    // Drives the push + in-app reminders (see jobs/attendance_jobs.js
    // runAttendanceReminders). Lead time = how many minutes BEFORE the event
    // the pre-reminder fires.
    reminders: {
      enabled: { type: Boolean, default: true },
      prePunchInMinutes: { type: Number, default: 10 }, // remind N min before shift start
      prePunchOutMinutes: { type: Number, default: 10 }, // remind N min before shift end
      atStart: { type: Boolean, default: true },         // "punch in now" reminder AT shift start
      lunch: { type: Boolean, default: true },           // lunch start/end reminders
      late: { type: Boolean, default: true },            // late alert after start+grace
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Unique per tenant, not globally — different tenants can each have their own "Morning" shift.
ShiftSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

module.exports = (mongoose.models["Shift"] || mongoose.model("Shift", ShiftSchema));
