// ---------------------------------------------------------------------------
// Shared shift/attendance status logic.
//
// Previously this was duplicated between attendance_controller.js and
// location_controller.js (flagged as a drift risk during audit — the two
// copies had already diverged on null-vs-truthy checks). Centralizing it here
// also fixes three requirement gaps found in that audit:
//   DC-2/DC-3 — tiered classification (Full / Half / Present) instead of a
//               binary Full-or-Half split with no floor.
//   SH-7/DC-4 — a Full Day is downgraded to Half Day once the employee's
//               late count for the month exceeds the shift's configured
//               allowance, even though hours alone would qualify for Full Day.
//   SH-10/11/DC-5 — overtime minutes are actually computed (previously the
//               field existed but nothing ever wrote to it).
// ---------------------------------------------------------------------------
const Attendance = require("../models/attendance_model");

// Configured lunch length in minutes for a shift, or 0 if lunch isn't
// configured. fixed_window = end−start; flexible_duration = durationMinutes.
function configuredLunchMinutes(shift) {
  const l = shift && shift.lunch;
  if (!l || !l.enabled) return 0;
  if (l.mode === "fixed_window" && l.startTime && l.endTime) {
    const [sh, sm] = l.startTime.split(":").map(Number);
    const [eh, em] = l.endTime.split(":").map(Number);
    let mins = eh * 60 + em - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    return Math.max(0, mins);
  }
  return Math.max(0, Number(l.durationMinutes) || 0);
}

// Sum of all closed session durations (root punchIn/punchOut + sessions[])
// minus lunch, in hours. Single source of truth — shared between the two
// controllers and the jobs. `shift` is optional; when its lunch config is
// present the deduction follows the admin's chosen model:
//   lunch.deduction "auto"  → always subtract the configured lunch length
//                             (employees needn't punch lunch)
//   lunch.deduction "punch" → subtract the ACTUAL lunch-in/out gap, but NEVER
//                             less than the configured length — i.e.
//                             max(actual, configured). NOT capped: a longer
//                             lunch costs its full actual time; a shorter lunch
//                             still costs the configured minimum (no credit for
//                             cutting lunch short).
// With no lunch config (or no shift) it falls back to the raw punched-lunch
// gap — the original behaviour.
//
// Example (60-min configured lunch, "punch" mode):
//   takes 80m → 80m deducted   (full actual, over the allowance)
//   takes 40m → 60m deducted   (configured floor, short lunch not credited)
//   takes 120m → 120m deducted (full actual)
// The over-limit is also flagged separately (see lunchOverLimit in
// finalizeAttendanceStatus) so admin views can highlight long breaks.
function computeTotalHours(attendance, shift) {
  const date = attendance.date;
  const toMs = (timeStr) => {
    if (!timeStr) return null;
    const normalized = timeStr.includes("T") || timeStr.includes(" ") ? timeStr : `${date}T${timeStr}`;
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d.getTime();
  };

  let totalMs = 0;
  const s1In = toMs(attendance.punchIn?.time);
  const s1Out = toMs(attendance.punchOut?.time);
  if (s1In !== null && s1Out !== null) totalMs += Math.max(0, s1Out - s1In);

  for (const session of attendance.sessions || []) {
    const sIn = toMs(session.punchIn?.time);
    const sOut = toMs(session.punchOut?.time);
    if (sIn !== null && sOut !== null) totalMs += Math.max(0, sOut - sIn);
  }

  // Actual punched lunch gap (if the employee punched lunch in AND out).
  const lIn = toMs(attendance.lunchIn?.time);
  const lOut = toMs(attendance.lunchOut?.time);
  const punchedLunchMs = lIn !== null && lOut !== null && lOut > lIn ? lOut - lIn : 0;

  const cfgMins = configuredLunchMinutes(shift);
  let lunchDeductMs;
  if (cfgMins > 0) {
    const cfgMs = cfgMins * 60_000;
    lunchDeductMs =
      (shift.lunch.deduction || "auto") === "auto"
        ? cfgMs // always deduct the configured lunch
        : Math.max(punchedLunchMs, cfgMs); // actual, floored at configured (no credit for short lunch; full cost for long)
  } else {
    lunchDeductMs = punchedLunchMs; // no config → raw punched gap (legacy behaviour)
  }
  totalMs -= lunchDeductMs;

  return Math.max(0, totalMs) / (1000 * 60 * 60);
}

// Actual lunch minutes the employee punched (lunchOut − lunchIn), 0 if either
// end is missing or the times are out of order. Stored raw on the record so the
// admin views can show the true break length even when it exceeds the allowance.
function actualLunchMinutes(attendance) {
  const date = attendance.date;
  const toMs = (t) => {
    if (!t) return null;
    const normalized = t.includes("T") || t.includes(" ") ? t : `${date}T${t}`;
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d.getTime();
  };
  const lIn = toMs(attendance.lunchIn?.time);
  const lOut = toMs(attendance.lunchOut?.time);
  if (lIn === null || lOut === null || lOut <= lIn) return 0;
  return Math.round((lOut - lIn) / 60_000);
}

// Shift's total scheduled duration in hours, from startTime/endTime ("HH:mm").
// Falls back to 8h if no shift is assigned.
function getShiftDurationHours(shift) {
  if (!shift?.startTime || !shift?.endTime) return 8;
  const [sh, sm] = shift.startTime.split(":").map(Number);
  const [eh, em] = shift.endTime.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight shift
  return mins / 60;
}

// EXPECTED WORK hours = shift span minus the configured lunch — the time the
// employee is actually expected to be working. A 09:30–18:30 shift with a 1h
// configured lunch expects 8h of work. Classification (Full/Half) compares
// worked hours against THIS, not the raw span — otherwise, with auto-deducted
// lunch, an employee present for the entire shift would land at 8h/9h ≈ 89%
// and Full Day would be unreachable. Floor of 0.5h guards against a
// misconfigured lunch longer than the shift itself.
function getEffectiveShiftHours(shift) {
  return Math.max(0.5, getShiftDurationHours(shift) - configuredLunchMinutes(shift) / 60);
}

// How many days THIS MONTH (1st of month through and including `dateStr`)
// the employee has been marked late. Used to apply the monthly-allowance
// override — must include today's record (already saved with lateMinutes
// before finalize runs) so the day that crosses the threshold is itself
// the one that gets downgraded.
async function countLateDaysThisMonth(userId, dateStr) {
  const monthPrefix = dateStr.slice(0, 8); // "YYYY-MM-"
  return Attendance.countDocuments({
    userId,
    date: { $gte: `${monthPrefix}01`, $lte: dateStr },
    lateMinutes: { $gt: 0 },
  });
}

// Overtime minutes worked past the shift's end (+ grace threshold to decide
// IF overtime applies at all — mirrors how lateMinutes counts from shift
// START rather than from the late-grace cutoff). Uses the LATEST closed
// punch-out across the root session and sessions[]; recomputed on every
// punch-out close, so it can only grow across the day as later sessions close.
function computeOvertimeMinutes(attendance, shift) {
  if (!shift?.endTime) return 0;
  const date = attendance.date;
  const toMs = (t) => {
    if (!t) return null;
    const d = new Date(`${date}T${t}`);
    return isNaN(d.getTime()) ? null : d.getTime();
  };

  const closeTimes = [toMs(attendance.punchOut?.time)];
  for (const s of attendance.sessions || []) closeTimes.push(toMs(s.punchOut?.time));
  const validCloses = closeTimes.filter((t) => t !== null);
  if (!validCloses.length) return 0;
  const lastCloseMs = Math.max(...validCloses);

  let shiftEndMs = new Date(`${date}T${shift.endTime}`).getTime();
  if (shift.startTime) {
    const [sh, sm] = shift.startTime.split(":").map(Number);
    const [eh, em] = shift.endTime.split(":").map(Number);
    // Overnight shift — the end instant falls on the next calendar day.
    if (eh * 60 + em <= sh * 60 + sm) shiftEndMs += 24 * 3600 * 1000;
  }
  const graceMs = (Number(shift.overtimeGraceMinutes) || 0) * 60_000;
  if (lastCloseMs - shiftEndMs <= graceMs) return 0;
  return Math.round((lastCloseMs - shiftEndMs) / 60_000);
}

// Minutes the employee's FINAL punch-out fell SHORT of the shift end, once that
// shortfall exceeds the early-out grace (shift.earlyOutGraceMinutes, default
// 15). Mirror image of computeOvertimeMinutes on the other end of the shift.
// Returns 0 while any punch/session is still open (still on duty), when there's
// no completed punch-out, or when the shift end/times are missing.
function computeEarlyOutMinutes(attendance, shift) {
  if (!shift?.endTime) return 0;

  // Still on duty → not an early-out. Guard the root punch and every session.
  const rootOpen = attendance.punchIn?.time && !attendance.punchOut?.time;
  const sessionOpen = (attendance.sessions || []).some(
    (s) => s.punchIn?.time && !s.punchOut?.time
  );
  if (rootOpen || sessionOpen) return 0;

  const date = attendance.date;
  const toMs = (t) => {
    if (!t) return null;
    const d = new Date(`${date}T${t}`);
    return isNaN(d.getTime()) ? null : d.getTime();
  };

  // The day's TRUE final out = latest close across the root session + sessions[].
  const closeTimes = [toMs(attendance.punchOut?.time)];
  for (const s of attendance.sessions || []) closeTimes.push(toMs(s.punchOut?.time));
  const validCloses = closeTimes.filter((t) => t !== null);
  if (!validCloses.length) return 0;
  const lastCloseMs = Math.max(...validCloses);

  let shiftEndMs = new Date(`${date}T${shift.endTime}`).getTime();
  if (isNaN(shiftEndMs)) return 0;
  if (shift.startTime) {
    const [sh, sm] = shift.startTime.split(":").map(Number);
    const [eh, em] = shift.endTime.split(":").map(Number);
    if (eh * 60 + em <= sh * 60 + sm) shiftEndMs += 24 * 3600 * 1000; // overnight shift
  }

  const grace = Number(shift.earlyOutGraceMinutes);
  const graceMs = (Number.isFinite(grace) ? grace : 15) * 60_000;
  // Left at/after shift end, or within the grace window → not early.
  if (shiftEndMs - lastCloseMs <= graceMs) return 0;
  return Math.round((shiftEndMs - lastCloseMs) / 60_000);
}

// Single source of truth for the final day classification + overtime, called
// after every totalHours recompute on a punch-out path (manual, additional
// session, auto geo-fence, admin correction, end-of-day auto-close).
// Mutates `attendance.status` and `attendance.overtimeMinutes` in place.
//
//   worked >= 100% of shift duration  -> Full Day (or Half Day if the
//                                        monthly late allowance is exceeded)
//   worked 0%..99.99% (any completed  -> Half Day
//     punch under the full shift)
//   no completed punch at all         -> never set here; the read-side
//                                        effective-status helpers report
//                                        "Absent" — see computeEffectiveStatus
async function finalizeAttendanceStatus(attendance, shift) {
  // Authoritative recompute WITH the shift, so the stored worked hours reflect
  // the configured lunch deduction (the shift-less recompute on the punch-out
  // paths only produces an interim value; this is the final word).
  attendance.totalHours = computeTotalHours(attendance, shift);

  const shiftHours = getEffectiveShiftHours(shift);
  const ratio = shiftHours > 0 ? (attendance.totalHours || 0) / shiftHours : 0;

  let status = ratio >= 1 ? "Full Day" : "Half Day";

  // Late-allowance override: too many late days this month downgrades an
  // otherwise-Full Day to Half Day (per-shift allowedLateCountPerMonth).
  if (status === "Full Day" && shift && attendance.lateMinutes > 0) {
    const allowance = typeof shift.allowedLateCountPerMonth === "number" ? shift.allowedLateCountPerMonth : 3;
    const lateCount = await countLateDaysThisMonth(attendance.userId, attendance.date);
    if (lateCount > allowance) status = "Half Day";
  }

  attendance.status = status;
  attendance.overtimeMinutes = computeOvertimeMinutes(attendance, shift);
  attendance.earlyOutMinutes = computeEarlyOutMinutes(attendance, shift);

  // Record the real break length and whether it blew past the shift's allowance
  // so the attendance views can flag long lunches in red. The deduction above
  // already subtracted the full actual gap (punch mode) — this is the signal.
  const lunchMins = actualLunchMinutes(attendance);
  const cfgLunch = configuredLunchMinutes(shift);
  attendance.lunchMinutes = lunchMins;
  attendance.lunchOverLimit = cfgLunch > 0 && lunchMins > cfgLunch;
}

module.exports = {
  computeTotalHours,
  configuredLunchMinutes,
  actualLunchMinutes,
  getShiftDurationHours,
  getEffectiveShiftHours,
  countLateDaysThisMonth,
  computeOvertimeMinutes,
  computeEarlyOutMinutes,
  finalizeAttendanceStatus,
};
