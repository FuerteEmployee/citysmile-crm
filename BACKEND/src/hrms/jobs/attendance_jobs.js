/**
 * attendance_jobs — end-of-day safety sweep + shift/lunch reminder engine.
 *
 * E-8 (closeForgottenPunches): an employee who forgets to punch out previously
 * left that day's attendance doc open forever. Runs daily (04:00 IST) against
 * YESTERDAY only.
 *
 * runAttendanceReminders(): runs every minute; for each active geofenced
 * employee it derives reminder instants from their shift + lunch config and
 * fires push + in-app reminders (pre-punch-in, late, lunch start/end,
 * pre-punch-out) the minute they're due — only if the reminder still applies
 * (e.g. not already punched in). Push lands on phones via FCM; in-app via
 * socket. Both channels are best-effort.
 */
const Attendance = require("../models/attendance_model");
const Shift = require("../models/shift_model");
const User = require("../models/user_model");
const { computeTotalHours, finalizeAttendanceStatus } = require("../utils/shiftStatus");
const fcmService = require("../utils/fcm_service");
const realtime = require("../utils/realtime");

const isFieldRoleKey = (roleKey, roleLabel) => {
  const k = (roleKey || "").toLowerCase();
  const l = (roleLabel || "").toLowerCase();
  return (
    k.includes("field") || k.includes("sales") || k.includes("marketing_executive") ||
    l.includes("field executive") || l.includes("marketing executive") || l.includes("field staff")
  );
};

const istDateStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
// Current IST minutes-of-day (0..1439).
const istMinuteOfDay = () => {
  const s = new Date().toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const hhmmToMin = (t) => {
  if (!t || typeof t !== "string") return null;
  const [h, m] = t.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const fmt12 = (t) => {
  const min = hhmmToMin(t);
  if (min === null) return t;
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
};

// Dedup guard: which (userId:date:type) reminders have already fired. Cleared
// when the IST date rolls over. In-memory — a restart may re-send a reminder
// whose minute is currently due, which is acceptable for reminders.
let sentReminders = new Set();
let sentRemindersDate = istDateStr();

async function runAttendanceReminders() {
  if (!fcmService.isConfigured() && !realtime.getIO()) return { skipped: "no channels" };

  const today = istDateStr();
  if (today !== sentRemindersDate) { sentReminders = new Set(); sentRemindersDate = today; }
  const nowMin = istMinuteOfDay();

  // Active employees needing attendance, with a shift assigned.
  const employees = await User.find({
    isActive: true,
    attendanceRequired: { $ne: false },
    shiftId: { $ne: null },
  })
    .select("name fcmToken shiftId role")
    .populate("role", "role label")
    .populate("shiftId")
    .lean();

  if (!employees.length) return { date: today, nowMin, fired: 0 };

  // Today's attendance for those employees, mapped by userId.
  const ids = employees.map((e) => e._id);
  const attDocs = await Attendance.find({ userId: { $in: ids }, date: today })
    .select("userId punchIn.time punchOut.time lunchIn.time lunchOut.time sessions")
    .lean();
  const attByUser = new Map(attDocs.map((a) => [String(a.userId), a]));

  let fired = 0;
  for (const emp of employees) {
    if (isFieldRoleKey(emp.role?.role, emp.role?.label)) continue;
    const shift = emp.shiftId;
    const rem = shift?.reminders;
    if (!shift || !rem || rem.enabled === false) continue;
    if (!emp.fcmToken && !realtime.getIO()) continue;

    const att = attByUser.get(String(emp._id));
    const punchedIn = !!att?.punchIn?.time;
    const anyOpen = punchedIn && (!att.punchOut?.time || (att.sessions || []).some((s) => s.punchIn?.time && !s.punchOut?.time));
    const onLunch = !!att?.lunchIn?.time && !att?.lunchOut?.time;

    const startMin = hhmmToMin(shift.startTime);
    const endMin = hhmmToMin(shift.endTime);
    const events = [];

    // Pre-punch-in reminder — the advance "starting soon" nudge. Skipped when
    // the lead time is 0, since that would collide with the at-start reminder.
    const prePunchInLead = Number(rem.prePunchInMinutes) || 0;
    if (startMin !== null && !punchedIn && prePunchInLead > 0) {
      events.push({ type: "pre_punch_in", at: startMin - prePunchInLead,
        title: "Shift starting soon", body: `Your shift starts at ${fmt12(shift.startTime)}. Don't forget to punch in.` });
    }
    // At-shift-start reminder — the moment the shift begins, if still not
    // punched in. This is the "you're due now" nudge (fires exactly at start).
    if (startMin !== null && !punchedIn && rem.atStart !== false) {
      events.push({ type: "punch_in_now", at: startMin,
        title: "Time to punch in", body: `Your shift has started (${fmt12(shift.startTime)}). Please punch in now.` });
    }
    // Late reminder — at start + grace, if still not punched in.
    if (startMin !== null && !punchedIn && rem.late !== false) {
      events.push({ type: "late", at: startMin + (Number(shift.lateGraceMinutes) || 0),
        title: "You're running late", body: `Punch in now — you're past your ${fmt12(shift.startTime)} start time.` });
    }
    // Lunch reminders — only when lunch is configured as a fixed window.
    if (rem.lunch !== false && shift.lunch?.enabled && shift.lunch.mode === "fixed_window" && punchedIn) {
      const lStart = hhmmToMin(shift.lunch.startTime);
      const lEnd = hhmmToMin(shift.lunch.endTime);
      if (lStart !== null && !onLunch && anyOpen) events.push({ type: "lunch_start", at: lStart, title: "Lunch break", body: `Lunch time — ${fmt12(shift.lunch.startTime)} to ${fmt12(shift.lunch.endTime)}.` });
      if (lEnd !== null) events.push({ type: "lunch_end", at: lEnd, title: "Lunch over", body: "Time to resume work — end your lunch break." });
    }
    // Pre-punch-out reminder — only if still on duty.
    if (endMin !== null && anyOpen) {
      events.push({ type: "pre_punch_out", at: endMin - (Number(rem.prePunchOutMinutes) || 0),
        title: "Shift ending soon", body: `Your shift ends at ${fmt12(shift.endTime)}. Remember to punch out.` });
    }

    for (const ev of events) {
      if (ev.at !== nowMin) continue; // fire only in the exact due minute
      const key = `${emp._id}:${today}:${ev.type}`;
      if (sentReminders.has(key)) continue;
      sentReminders.add(key);
      fired++;
      if (emp.fcmToken) {
        fcmService.sendPushNotification({
          token: emp.fcmToken, title: ev.title, body: ev.body,
          data: { action: "REMINDER", type: ev.type },
        }).catch(() => {});
      }
      realtime.emitToUser(emp._id, "attendance_reminder", { type: ev.type, title: ev.title, body: ev.body });
    }
  }
  return { date: today, nowMin, employees: employees.length, fired };
}

// IST "yesterday" as a YYYY-MM-DD string — the same format attendance.date
// uses everywhere else.
function istYesterday() {
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  istNow.setDate(istNow.getDate() - 1);
  const y = istNow.getFullYear();
  const m = String(istNow.getMonth() + 1).padStart(2, "0");
  const d = String(istNow.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hasOpenSession(att) {
  const mainOpen = att.punchIn?.time && !att.punchOut?.time;
  const additionalOpen = (att.sessions || []).some((s) => s.punchIn?.time && !s.punchOut?.time);
  return mainOpen || additionalOpen;
}

// extraFilter merges into the query — used by tests to scope a dry run to a
// synthetic userId instead of touching every employee's records.
async function closeForgottenPunches(extraFilter = {}) {
  const dateStr = istYesterday();
  const candidates = await Attendance.find({ date: dateStr, ...extraFilter });
  const open = candidates.filter(hasOpenSession);

  let closed = 0;
  for (const attendance of open) {
    const shift = attendance.shiftId
      ? await Shift.findById(attendance.shiftId)
          .select("startTime endTime overtimeGraceMinutes overtimeRatePerHour allowedLateCountPerMonth lunch")
          .lean()
      : null;
    // Close at the shift's own end time (not literal end-of-day) — this
    // avoids crediting absurd hours for a punch nobody ever confirmed, and
    // naturally computes zero overtime for a record nobody actually worked.
    const closeTime = `${shift?.endTime || "18:00"}:00`;

    const sessions = attendance.sessions || [];
    const openIdx = sessions.findIndex((s) => s.punchIn?.time && !s.punchOut?.time);

    if (openIdx !== -1) {
      const s = sessions[openIdx];
      const sInMs = new Date(`${dateStr}T${s.punchIn.time}`).getTime();
      const sOutMs = new Date(`${dateStr}T${closeTime}`).getTime();
      attendance.sessions[openIdx].punchOut = { time: closeTime };
      attendance.sessions[openIdx].durationMins =
        Number.isFinite(sInMs) && Number.isFinite(sOutMs)
          ? Math.max(0, Math.round((sOutMs - sInMs) / 60_000))
          : 0;
      attendance.sessions[openIdx].closeReason = "shift_end";
    } else if (attendance.punchIn?.time && !attendance.punchOut?.time) {
      attendance.set("punchOut.time", closeTime);
      attendance.set("punchOut.closeReason", "shift_end");
    } else {
      continue; // defensive — hasOpenSession already filtered for this
    }

    if (!attendance.notes) {
      attendance.notes = "Automatically closed by end-of-day job — punch-out was never recorded.";
    }
    attendance.totalHours = computeTotalHours(attendance);
    await finalizeAttendanceStatus(attendance, shift);
    await attendance.save();
    closed++;
  }

  console.log(
    `[AttendanceJobs] closeForgottenPunches: date=${dateStr} candidates=${candidates.length} closed=${closed}`,
  );
  return { date: dateStr, candidates: candidates.length, closed };
}

module.exports = { closeForgottenPunches, runAttendanceReminders };
