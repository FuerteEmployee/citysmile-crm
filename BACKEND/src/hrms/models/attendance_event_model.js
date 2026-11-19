const mongoose = require("mongoose");

// Append-only log of every punch event with its location context. The
// attendance doc stores the day's STATE (sessions, totals); this stores the
// EVENTS — one row per punch, never updated — so the employee app can show
// "Punched in — 9:32 AM · 24m from Rajkot branch" and disputes can be
// reconstructed without decoding the sessions array. Raw coords are kept;
// distance-from-branch is precomputed for display.
const attendanceEventSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    branchId:   { type: mongoose.Schema.Types.ObjectId, ref: "HRMSBranch", default: null },
    date:       { type: String, required: true }, // YYYY-MM-DD (IST)
    type: {
      type: String,
      enum: ["PUNCH_IN", "PUNCH_OUT", "AUTO_PUNCH_OUT"],
      required: true,
    },
    source: {
      type: String,
      enum: ["MANUAL", "GEOFENCE", "FACE"], // FACE = Face Attendance kiosk
      default: "MANUAL",
    },
    at:   { type: Date, required: true },  // true event instant (historical for offline replay)
    time: { type: String },                // HH:mm:ss IST — matches attendance doc display fields
    sessionNumber: { type: Number, default: null }, // 1 = root session
    lat:      { type: Number, default: null },
    lng:      { type: Number, default: null },
    accuracy: { type: Number, default: null },
    distanceFromBranch: { type: Number, default: null }, // metres at event time
  },
  { timestamps: true },
);

attendanceEventSchema.index({ employeeId: 1, date: 1 });

module.exports = (mongoose.models["AttendanceEvent"] || mongoose.model("AttendanceEvent", attendanceEventSchema));
