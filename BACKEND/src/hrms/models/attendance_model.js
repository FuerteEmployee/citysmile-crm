const mongoose = require("mongoose");

const AttendanceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    // Finalized only once a day's work is complete (punch-out with no open
    // session). Computed from hours worked vs the assigned shift's duration —
    // see finalizeAttendanceStatus() in utils/shiftStatus.js. Left unset while
    // a day is still in progress or incomplete; the read-side effective-status
    // helper fills in "On Duty" (today, in progress) or "Absent" (past day,
    // never completed) for those cases without persisting a guess.
    // Full Day = worked >= 100% of the shift's duration; Half Day = any
    // completed punch under that; Absent = never punched in (never persisted
    // here — the read-side effective-status helper derives it). "Half Day" can
    // also be forced by exceeding the shift's allowed monthly late count, even
    // if hours alone would qualify for Full Day (see countLateDaysThisMonth
    // in shiftStatus.js).
    status: {
      type: String,
      enum: ["Full Day", "Half Day", "Absent"],
      default: undefined,
    },
    punchIn: {
      time: String,
      selfieUrl: String,
      location: {
        lat: Number,
        lng: Number,
        address: String,
        accuracy: Number, // GPS accuracy (m) reported by the client at capture
        fixAt: Date,      // when the client captured the fix
      },
    },
    punchOut: {
      time: String,
      selfieUrl: String,
      location: {
        lat: Number,
        lng: Number,
        address: String,
        accuracy: Number,
        fixAt: Date,
      },
      // Set only by the end-of-day auto-close job when a punch-out was never
      // recorded (see jobs/attendance_jobs.js). Mirrors sessions[].closeReason.
      // NO default here: a default on any nested field makes Mongoose
      // auto-instantiate the whole punchOut object on every document, even
      // before anyone has punched out — `attendance.punchOut` would then be
      // a truthy {} instead of undefined, and every "!attendance.punchOut"
      // truthiness check (frontend status derivation, isPresentRecord, etc.)
      // would treat a freshly punched-in employee as already punched out.
      closeReason: {
        type: String,
        enum: ["manual", "auto_geofence", "shift_end", "admin"],
      },
    },
    lunchIn: {
      time: String,
      selfieUrl: String,
      location: {
        lat: Number,
        lng: Number,
        address: String,
      },
    },
    lunchOut: {
      time: String,
      selfieUrl: String,
      location: {
        lat: Number,
        lng: Number,
        address: String,
      },
    },
    totalHours: {
      type: Number,
      default: 0,
    },
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    selfieVerificationStatus: {
      type: String,
      enum: ["pending", "verified", "failed", "manual_override"],
      default: "pending"
    },
    geoStatus: {
      type: String,
      enum: ["inside_geofence", "outside_geofence", "remote_allowed", "unknown"],
      default: "unknown"
    },
    regularizationRequested: {
      type: Boolean,
      default: false
    },
    regularizationReason: {
      type: String,
      default: ""
    },
    source: {
      type: String,
      enum: ["mobile", "web", "admin", "face"], // face = Face Attendance kiosk
      default: "web",
    },
    lateMinutes: {
      type: Number,
      default: 0,
    },
    overtimeMinutes: {
      type: Number,
      default: 0,
    },
    // Minutes the final punch-out fell short of shift end, once past the shift's
    // early-out grace (shift.earlyOutGraceMinutes, default 15). Computed at
    // punch-out by finalizeAttendanceStatus() — mirror of overtimeMinutes.
    // Drives the orange "early out" label alongside the late indicator.
    earlyOutMinutes: {
      type: Number,
      default: 0,
    },
    // Actual lunch minutes the employee punched (lunchOut − lunchIn), stored raw
    // regardless of the deduction cap so admins can see over-limit breaks.
    lunchMinutes: {
      type: Number,
      default: 0,
    },
    // True when the punched lunch exceeded the shift's configured lunch length.
    // Drives the red "Long Lunch" badge in the attendance views.
    lunchOverLimit: {
      type: Boolean,
      default: false,
    },
    autoPunchOut: {
      type: Boolean,
      default: false,
    },
    autoPunchOutReason: {
      type: String,
      default: "",
    },
    geoFenceViolation: {
      type: Boolean,
      default: false,
    },
    calculatedDistance: {
      type: Number,
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved", // default to approved for normal punches unless it requires manual approval
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Additional punch sessions (Session 2, 3, 4, 5).
    // Session 1 is always stored in the root punchIn / punchOut fields above
    // for backward compatibility with existing queries and admin panels.
    sessions: [
      {
        sessionNumber: { type: Number, required: true },   // 2, 3, 4, 5
        punchIn: {
          time:     { type: String, required: true },
          selfieUrl:{ type: String, default: null  },
          location: { lat: Number, lng: Number, address: String, accuracy: Number, fixAt: Date },
        },
        punchOut: {
          time:     { type: String, default: null },
          selfieUrl:{ type: String, default: null },
          location: { lat: Number, lng: Number, address: String, accuracy: Number, fixAt: Date },
        },
        durationMins: { type: Number, default: null },  
        closeReason: {
          type: String,
          enum: ["manual", "auto_geofence", "shift_end", "admin"],
          default: "manual",
        },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The day's TRUE final out-time. Root punchOut is Session 1's out-time by
// design (backward compat), so reports reading it show the FIRST session's
// out even when later sessions ended hours after. Null while any session is
// still open — there is no final out yet.
AttendanceSchema.virtual("lastPunchOut").get(function () {
  const sessions = this.sessions || [];
  const mainOpen = this.punchIn?.time && !this.punchOut?.time;
  const additionalOpen = sessions.some((s) => s.punchIn?.time && !s.punchOut?.time);
  if (mainOpen || additionalOpen) return null;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i]?.punchOut?.time) return sessions[i].punchOut;
  }
  return this.punchOut?.time ? this.punchOut : null;
});

// Index for quick queries
AttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = (mongoose.models["Attendance"] || mongoose.model("Attendance", AttendanceSchema));
