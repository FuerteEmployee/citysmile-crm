const AttendanceEvent = require("../models/attendance_event_model");

// Fire-and-forget event write — the punch flow must never fail or slow down
// because the log couldn't be written.
function logAttendanceEvent(fields) {
  AttendanceEvent.create(fields).catch((e) =>
    console.error("[AttendanceEvent] write failed:", e.message),
  );
}

module.exports = { logAttendanceEvent };
