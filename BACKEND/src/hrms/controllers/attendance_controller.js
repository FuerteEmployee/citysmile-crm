const Attendance = require("../models/attendance_model");
const User = require("../models/user_model");
const Shift = require("../models/shift_model");
const Store = require("../models/store_model");
const HRMSBranch = require("../models/hrms_branch_model");
const { getISTDate, getISTTime } = require("../utils/timeUtils");
const { isRealDate } = require("../utils/fieldRules");
const { uploadToCloudinary } = require("../utils/cloudinary_config");
const { medianOutside, clearFixes, GEOFENCE_WINDOW_MIN, GEOFENCE_GRACE_MS } = require("../utils/geofenceWindow");
const { reverseGeocode } = require("../utils/geocode");
const { computeTotalHours, getShiftDurationHours, finalizeAttendanceStatus, computeOvertimeMinutes, computeEarlyOutMinutes, actualLunchMinutes, configuredLunchMinutes } = require("../utils/shiftStatus");
const { logAttendanceEvent } = require("../utils/attendance_event_logger");
const AttendanceEvent = require("../models/attendance_event_model");
const GeofenceAudit = require("../models/geofence_audit_model");
const fcmService = require("../utils/fcm_service");
const { scopedUserFilter, scopedUserIds, canActOnEmployee, OUT_OF_SCOPE_MESSAGE, isTenantAdmin } = require("../utils/branchScope");
const { verifySelfie, selfieRejection } = require("../utils/faceRecognition");
const { tenantHasFeature } = require("../../utils/tenantFeatures");

const format12Hour = (timeStr) => {
  if (!timeStr) return "";
  const parts = timeStr.split(":");
  if (parts.length < 2) return timeStr;
  let hours = parseInt(parts[0], 10);
  const minutes = parts[1];
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
};

// Maximum additional sessions per day (Session 1 = root punchIn, Sessions 2-N = sessions[])
const MAX_ADDITIONAL_SESSIONS = 4;

// Lets AttendanceDashboardPage.tsx refresh live instead of only on manual
// reload/filter change — mirrors the same req.app.get("io").emit(...)
// fire-and-forget pattern location_controller.js already uses for
// "location_update".
function emitAttendanceUpdate(req, payload) {
  const io = req.app.get("io");
  if (io) io.emit("attendance_update", payload);
}

// Called by every punchOut path (manual, additional session, auto geo-fence,
// admin correction). Session 1 lives in root punchIn/punchOut; sessions 2+
// live in the sessions[] array; lunch (once per day) lives in root
// lunchIn/lunchOut. Implementation is shared with location_controller.js —
// see computeTotalHours() in utils/shiftStatus.js.
function recomputeTotalHours(attendance) {
  return computeTotalHours(attendance);
}

// Loads the shift fields finalizeAttendanceStatus needs (duration, overtime
// grace/rate, monthly late allowance). Centralized here so every call site
// selects the same fields — getShiftDurationHours/finalizeAttendanceStatus
// themselves live in utils/shiftStatus.js (shared with location_controller.js
// to avoid the two controllers drifting out of sync on this logic).
async function loadShiftForFinalize(attendance) {
  if (!attendance.shiftId) return null;
  return Shift.findById(attendance.shiftId)
    .select("startTime endTime lateGraceMinutes overtimeGraceMinutes earlyOutGraceMinutes overtimeRatePerHour allowedLateCountPerMonth lunch")
    .lean();
}

// A record counts as "not absent" only if the day was actually completed
// (punch-out done) or it's today and still in progress (punched in, no
// punch-out yet — "On Duty", not Absent). A past day left with just a
// punch-in and no punch-out is Absent until an admin corrects it.
function isPresentRecord(rec, targetDate) {
  if (!rec?.punchIn?.time) return false;
  if (rec.punchOut?.time) return true;
  return rec.date === getISTDate() && rec.date === targetDate;
}

// Field / sales / marketing roles roam by design — geofence enforcement
// (auto punch-out, punch-out gate) never applies to them.
function isFieldRole(user) {
  const roleKey = (user?.role?.role || "").toLowerCase();
  const roleLabel = (user?.role?.label || "").toLowerCase();
  return (
    roleKey.includes("field") ||
    roleKey.includes("sales") ||
    roleKey.includes("marketing_executive") ||
    roleLabel.includes("field executive") ||
    roleLabel.includes("marketing executive") ||
    roleLabel.includes("field staff")
  );
}

// ── Punch / lunch state-machine helpers ─────────────────────────────────────
// The day has an OPEN session when Session 1 is punched in without a punch-out,
// or any additional session is punched in without a punch-out.
function hasOpenSession(att) {
  const mainOpen = att?.punchIn?.time && !att?.punchOut?.time;
  const additionalOpen = (att?.sessions || []).some(
    (s) => s.punchIn?.time && !s.punchOut?.time,
  );
  return Boolean(mainOpen || additionalOpen);
}

// Lunch is OPEN when it has been started (lunchIn) but not yet ended (lunchOut).
// While lunch is open the ONLY valid next action is Lunch Out — starting a new
// session, punching out and starting another lunch are all blocked. This is
// what keeps lunch strictly nested inside a session and prevents orphaned
// lunchIn rows (lunch recorded after a punch-out with no matching lunchOut).
function isLunchOpen(att) {
  return Boolean(att?.lunchIn?.time && !att?.lunchOut?.time);
}

// Face Attendance kiosk punches (face_controller.kioskPunch) are run through
// punchIn/punchOut with req.punchSource = "face_kiosk", after the kiosk has
// already matched the face — so no selfie re-check, and events are tagged FACE.
const isKioskPunch = (req) => req.punchSource === "face_kiosk";
const punchEventSource = (req) => (isKioskPunch(req) ? "FACE" : "MANUAL");

// Selfie face check for an employee's own punch. Returns the block message, or
// null to go ahead; the check result (null when not run) sets
// selfieVerificationStatus. Only employees with an enrolled face, in a company
// with the face_attendance feature switched on, are checked.
async function checkSelfieFace(req, userId) {
  if (!req.file?.buffer || isKioskPunch(req)) return { check: null, blocked: null };
  if (!(await tenantHasFeature(req.user?.tenant_id, "face_attendance"))) return { check: null, blocked: null };
  const check = await verifySelfie(userId, req.file.buffer);
  return { check, blocked: selfieRejection(check) };
}

function selfieStatusFor(req, check, faceDetected) {
  if (isKioskPunch(req) || check?.status === "verified") return "verified";
  if (check?.status === "unavailable") return "pending";
  return faceDetected === "false" ? "failed" : "verified";
}

// The punch state machine, shared with the Face Attendance kiosk so it picks
// the same next action (punch in vs out) these handlers would accept.
exports.hasOpenSession = hasOpenSession;
exports.isLunchOpen = isLunchOpen;

// Log one punch event with its geo context (fire-and-forget). branch must be
// the populated hrmsBranchId doc (or null) so distance can be computed.
function logPunchEvent({ userId, branch, date, type, source, timeString, sessionNumber, lat, lng, accuracy }) {
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  const accN = parseFloat(accuracy);
  let distanceFromBranch = null;
  if (!isNaN(latN) && !isNaN(lngN) && branch?.latitude && branch?.longitude) {
    const d = getDistanceFromLatLonInM(latN, lngN, branch.latitude, branch.longitude);
    if (d !== null) distanceFromBranch = Math.round(d);
  }
  logAttendanceEvent({
    employeeId: userId,
    branchId: branch?._id || null,
    date,
    type,
    source,
    at: new Date(),
    time: timeString,
    sessionNumber: sessionNumber ?? null,
    lat: isNaN(latN) ? null : latN,
    lng: isNaN(lngN) ? null : lngN,
    accuracy: isNaN(accN) ? null : accN,
    distanceFromBranch,
  });
}

// Normalize client-reported fix quality for storage on location subdocs.
function fixQuality(accuracy, fixAt) {
  const acc = parseFloat(accuracy);
  const at = fixAt ? new Date(fixAt) : null;
  return {
    accuracy: !isNaN(acc) ? acc : undefined,
    fixAt: at && !isNaN(at.getTime()) ? at : new Date(),
  };
}

// Helper function to calculate distance in meters between two lat/lng
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371e3;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

exports.punchIn = async (req, res) => {
  try {
    const { lat, lng, accuracy, fixAt, faceDetected } = req.body;
    const date = getISTDate();
    const userId = req.user.userId || req.user.id;

    // Reject if GPS accuracy is too poor (cell tower / WiFi fallback — can be km off)
    const accuracyM = parseFloat(accuracy);
    if (!isNaN(accuracyM) && accuracyM > 150) {
      return res.status(403).json({
        success: false,
        message: `GPS accuracy is too poor (${Math.round(accuracyM)}m). Please step outside for a better GPS signal and try again.`,
      });
    }

    const faceCheck = await checkSelfieFace(req, userId);
    if (faceCheck.blocked) {
      return res.status(403).json({ success: false, faceMismatch: true, message: faceCheck.blocked });
    }
    const selfieStatus = selfieStatusFor(req, faceCheck.check, faceDetected);

    let [attendance, user] = await Promise.all([
      Attendance.findOne({ userId, date }),
      User.findById(userId)
        .select("shiftId hrmsBranchId storeId fcmToken")
        .populate({
          path: "shiftId",
          select: "startTime lateGraceMinutes",
        })
        .populate({
          path: "hrmsBranchId",
          select: "geoFenceEnabled latitude longitude radius radiusUnit name",
        }),
    ]);

    // ── Re-entry path: attendance record already exists ────────────────────
    if (attendance) {
      const sessions = attendance.sessions || [];

      // State-machine guard: an open lunch break must be ended first — no new
      // session may start while the employee is on lunch. Checked before the
      // open-session guard so the message tells them to punch out of lunch.
      if (isLunchOpen(attendance)) {
        return res.status(400).json({
          success: false,
          message: "Please end your lunch break before starting a new session.",
        });
      }

      // State-machine guard: reject if any session is currently open
      const mainOpen = attendance.punchIn?.time && !attendance.punchOut?.time;
      const additionalOpen = sessions.some(
        (s) => s.punchIn?.time && !s.punchOut?.time,
      );
      if (mainOpen || additionalOpen) {
        return res.status(400).json({
          success: false,
          message:
            "You are currently punched in. Please punch out before starting a new session.",
        });
      }

      // Daily session cap
      if (sessions.length >= MAX_ADDITIONAL_SESSIONS) {
        return res.status(400).json({
          success: false,
          message: `Maximum daily session limit (${MAX_ADDITIONAL_SESSIONS + 1}) reached.`,
        });
      }

      // Geo-fence check (same rules as first punch-in)
      if (lat && lng) {
        const assignedBranch = user?.hrmsBranchId;
        if (
          assignedBranch?.geoFenceEnabled &&
          assignedBranch?.latitude &&
          assignedBranch?.longitude
        ) {
          let radiusM =
            typeof assignedBranch.radius === "number"
              ? assignedBranch.radius
              : 500;
          // radius is stored in metres (the branch form converts km→m on save)
          const distanceM = getDistanceFromLatLonInM(
            lat,
            lng,
            assignedBranch.latitude,
            assignedBranch.longitude,
          );
          if (distanceM !== null && distanceM > radiusM) {
            const distKm = (distanceM / 1000).toFixed(2);
            return res.status(403).json({
              success: false,
              geoFenceViolation: true,
              distance: Math.round(distanceM),
              allowedRadius: radiusM,
              message: `You are not at your assigned branch location. You are ${distKm} km away from ${assignedBranch.name}.`,
            });
          }
        }
      }

      const timeString = getISTTime();
      const sessionNumber = sessions.length + 2; // S1=root, S2=sessions[0], etc.
      const resolvedAddress = await reverseGeocode(lat, lng);

      attendance.sessions.push({
        sessionNumber,
        punchIn: {
          time: timeString,
          selfieUrl: null,
          location: { lat, lng, address: resolvedAddress, ...fixQuality(accuracy, fixAt) },
        },
      });

      await Promise.all([
        attendance.save(),
        User.findByIdAndUpdate(userId, { isTrackingActive: true }),
      ]);

      // Fence the geofence decision window at session start: pre-punch-in fixes
      // (where the employee was BEFORE returning) must never count as evidence
      // that they have "left". Without this, a fresh punch-in can be auto
      // punched out seconds later by a median dominated by stale positions.
      clearFixes(userId);

      logPunchEvent({
        userId, branch: user?.hrmsBranchId, date, type: "PUNCH_IN", source: punchEventSource(req),
        timeString, sessionNumber, lat, lng, accuracy,
      });

      res.status(200).json({
        success: true,
        data: attendance,
        message: `Session ${sessionNumber} started successfully.`,
      });
      emitAttendanceUpdate(req, { userId, date, type: "PUNCH_IN" });

      if (user?.fcmToken) {
        fcmService.sendPushNotification({
          token: user.fcmToken,
          title: "Punch In Successful",
          body: `You started session ${sessionNumber} at ${format12Hour(timeString)}.`,
          data: { action: "PUNCH_IN", sessionNumber: String(sessionNumber) }
        }).catch(err => console.error("FCM session-start notification error:", err));
      }

      // Selfie intentionally skipped for sessions 2+.
      // Identity was verified at Session 1; geo-fence enforces physical presence.
      // Skipping Cloudinary upload prevents unbounded storage growth.
      return;
    }
    // ── End re-entry path ───────────────────────────────────────────────────

    let lateMinutes = 0;
    let geoStatus = "unknown";
    const currentTimeStr = getISTTime();

    // Late minutes
    if (user && user.shiftId) {
      const shift = user.shiftId;
      const [shiftHour, shiftMinute] = shift.startTime.split(":").map(Number);
      const [currHour, currMinute] = currentTimeStr.split(":").map(Number);
      const diffMins =
        currHour * 60 + currMinute - (shiftHour * 60 + shiftMinute);
      if (diffMins > (shift.lateGraceMinutes || 0)) lateMinutes = diffMins;
    }

    // Geo-fence check against the user's ASSIGNED branch only
    let geoFenceViolation = false;
    let calculatedDistance = null;
    if (lat && lng) {
      const assignedBranch = user?.hrmsBranchId;
      if (
        assignedBranch &&
        assignedBranch.geoFenceEnabled &&
        assignedBranch.latitude &&
        assignedBranch.longitude
      ) {
        let radiusM =
          typeof assignedBranch.radius === "number"
            ? assignedBranch.radius
            : 500;
        // radius is stored in metres (the branch form converts km→m on save)

        const distanceM = getDistanceFromLatLonInM(
          lat,
          lng,
          assignedBranch.latitude,
          assignedBranch.longitude,
        );
        calculatedDistance = distanceM !== null ? Math.round(distanceM) : null;

        if (distanceM !== null && distanceM > radiusM) {
          const distKm = (distanceM / 1000).toFixed(2);
          const allowedKm = (radiusM / 1000).toFixed(2);
          return res.status(403).json({
            success: false,
            geoFenceViolation: true,
            distance: Math.round(distanceM),
            allowedRadius: radiusM,
            message: `You are not at your assigned branch location. You are ${distKm} km away from ${assignedBranch.name}. Please move within the allowed branch range to Punch In.`,
          });
        }
        geoStatus = "inside_geofence";
      }
    }

    const timeString = getISTTime();
    const punchInAddress = await reverseGeocode(lat, lng);

    // Save attendance immediately — do NOT wait for Cloudinary upload.
    // Responding fast is more important than having the selfie URL in the
    // first response. The upload completes async and patches the record.
    attendance = new Attendance({
      userId,
      date,
      shiftId: user ? user.shiftId?._id : null,
      storeId: user?.storeId ?? null,
      punchIn: {
        time: timeString,
        selfieUrl: null,
        location: { lat, lng, address: punchInAddress, ...fixQuality(accuracy, fixAt) },
      },
      // status is left unset here — it's only finalized at punch-out, once
      // hours worked can be compared against the assigned shift's duration.
      lateMinutes,
      geoStatus,
      geoFenceViolation,
      calculatedDistance,
      selfieVerificationStatus: selfieStatus,
      ...(isKioskPunch(req) ? { source: "face" } : {}),
    });

    await Promise.all([
      attendance.save(),
      User.findByIdAndUpdate(userId, { isTrackingActive: true }),
    ]);

    // Fence the geofence decision window at session start (see re-entry path).
    clearFixes(userId);

    logPunchEvent({
      userId, branch: user?.hrmsBranchId, date, type: "PUNCH_IN", source: punchEventSource(req),
      timeString, sessionNumber: 1, lat, lng, accuracy,
    });

    res.status(201).json({
      success: true,
      data: attendance,
      message: "Punched in successfully",
    });
    emitAttendanceUpdate(req, { userId, date, type: "PUNCH_IN" });

    if (user?.fcmToken) {
      fcmService.sendPushNotification({
        token: user.fcmToken,
        title: "Punch In Successful",
        body: `You punched in successfully at ${format12Hour(timeString)}.`,
        data: { action: "PUNCH_IN" }
      }).catch(err => console.error("FCM punch-in notification error:", err));
    }

    // Upload selfie in the background after responding — never blocks the user.
    if (req.file) {
      uploadToCloudinary(req.file)
        .then((url) =>
          Attendance.findByIdAndUpdate(attendance._id, {
            "punchIn.selfieUrl": url,
            selfieVerificationStatus: selfieStatus,
          }),
        )
        .catch((err) =>
          console.error("[PunchIn] Selfie upload error:", err.message),
        );
    }
  } catch (error) {
    console.error("Punch In Error:", error);
    res
      .status(500)
      .json({ message: "Error punching in", error: error.message });
  }
};

exports.autoPunchOut = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const date = getISTDate();
    const userId = req.user.userId || req.user.id;

    // Fetch user (with role + branch) and today's attendance in parallel
    const [user, attendance] = await Promise.all([
      User.findById(userId)
        .populate("role", "role label")
        .populate("hrmsBranchId", "latitude longitude radius radiusUnit"),
      Attendance.findOne({ userId, date }),
    ]);

    // Skip field / sales roles — they roam by design
    if (isFieldRole(user)) {
      return res.status(200).json({
        success: false,
        skipped: true,
        message: "Auto punch-out does not apply to sales/field staff",
      });
    }

    if (!attendance)
      // Nothing to punch out of (employee never punched in today). This is a
      // no-op, not an error — return skipped so the app ignores it silently
      // instead of showing a red "Server Communication Error".
      return res.status(200).json({
        success: false,
        skipped: true,
        message: "Auto punch-out skipped: no attendance record for today",
      });
    if (!attendance.punchIn || !attendance.punchIn.time)
      return res.status(400).json({
        success: false,
        skipped: true,
        message: "Auto punch-out skipped: no punch-in entry exists for today",
      });

    // On lunch break — auto punch-out is suspended. An employee who steps
    // outside the geofence for an authorized lunch must never be treated as
    // having "left"; only leaving lunchOut unset (not yet ended) counts.
    if (attendance.lunchIn?.time && !attendance.lunchOut?.time) {
      return res.status(200).json({
        success: false,
        skipped: true,
        message: "Auto punch-out skipped: employee is on lunch break",
      });
    }

    // Grace period: a session this young cannot be auto-closed. Both times are
    // parsed from IST strings the same way, so the comparison holds on any
    // server timezone.
    const openSess = (attendance.sessions || []).find(
      (s) => s.punchIn?.time && !s.punchOut?.time,
    );
    const openInTime = openSess
      ? openSess.punchIn.time
      : !attendance.punchOut?.time
        ? attendance.punchIn.time
        : null;
    if (openInTime) {
      const punchInMs = new Date(`${date}T${openInTime}`).getTime();
      const nowIstMs = new Date(`${getISTDate()}T${getISTTime()}`).getTime();
      if (
        Number.isFinite(punchInMs) &&
        Number.isFinite(nowIstMs) &&
        nowIstMs - punchInMs < GEOFENCE_GRACE_MS
      ) {
        return res.status(200).json({
          success: false,
          skipped: true,
          message: "Auto punch-out skipped: session just started (grace period)",
        });
      }
    }

    // ── Server-authoritative geofence gate ─────────────────────────────────
    // The client only TRIGGERS this; the server confirms with the windowed
    // median, so a confidently-wrong GPS fix can never punch out a present
    // employee. Not decided / inside → stay punched in (the client honours skipped).
    const branch = user?.hrmsBranchId;
    let geoVerdict = null;
    if (branch?.latitude && branch?.longitude) {
      const radiusM = typeof branch.radius === "number" ? branch.radius : 500; // metres
      geoVerdict = medianOutside(userId, branch.latitude, branch.longitude, radiusM);
      if (!geoVerdict.decided || !geoVerdict.outside) {
        return res.status(200).json({
          success: false,
          skipped: true,
          message: "Windowed median still inside geofence — staying punched in",
        });
      }
    }

    const timeString = getISTTime();

    // Silent audit trail — written automatically, looked at only if disputed.
    GeofenceAudit.create({
      userId, date, time: timeString, branchId: branch?._id,
      radiusM: typeof branch?.radius === "number" ? branch.radius : 500,
      medianLat: geoVerdict?.median?.lat, medianLng: geoVerdict?.median?.lng,
      distanceM: geoVerdict ? Math.round(geoVerdict.dist) : null,
      windowMin: GEOFENCE_WINDOW_MIN, fixesInWindow: geoVerdict?.n, trigger: "client",
      fixes: geoVerdict?.fixes,
    }).catch((e) => console.error("[GeoFence] audit write failed:", e.message));
    const reason =
      "Employee automatically punched out after leaving the assigned branch geo-fence area.";

    // Calculate distance from branch (if branch coordinates available)
    let calculatedDistance = null;
    if (
      lat &&
      lng &&
      user?.hrmsBranchId?.latitude &&
      user?.hrmsBranchId?.longitude
    ) {
      const dist = getDistanceFromLatLonInM(
        lat,
        lng,
        user.hrmsBranchId.latitude,
        user.hrmsBranchId.longitude,
      );
      if (dist !== null) calculatedDistance = Math.round(dist);
    }

    attendance.autoPunchOut = true;
    attendance.autoPunchOutReason = reason;
    attendance.geoFenceViolation = true;
    attendance.geoStatus = "outside_geofence";
    attendance.notes = reason;
    if (calculatedDistance !== null)
      attendance.calculatedDistance = calculatedDistance;

    // ── Additional session open? Close it first ────────────────────────────
    const sessions = attendance.sessions || [];
    const openIdx = sessions.findIndex(
      (s) => s.punchIn?.time && !s.punchOut?.time,
    );

    if (openIdx !== -1) {
      const openSession = sessions[openIdx];
      const sInMs = new Date(
        `${attendance.date}T${openSession.punchIn.time}`,
      ).getTime();
      const sOutMs = new Date(`${attendance.date}T${timeString}`).getTime();
      const durationMins = Math.max(0, Math.round((sOutMs - sInMs) / 60000));

      attendance.sessions[openIdx].punchOut = {
        time: timeString,
        location: { lat, lng, ...fixQuality(accuracy, null) },
      };
      attendance.sessions[openIdx].durationMins = durationMins;
      attendance.sessions[openIdx].closeReason = "auto_geofence";
      attendance.totalHours = recomputeTotalHours(attendance);
      await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));

      await Promise.all([
        attendance.save(),
        User.findByIdAndUpdate(userId, { isTrackingActive: false }),
      ]);

      logPunchEvent({
        userId, branch, date, type: "AUTO_PUNCH_OUT", source: "GEOFENCE",
        timeString, sessionNumber: openSession.sessionNumber, lat, lng, accuracy,
      });

      if (user?.fcmToken) {
        fcmService.sendPushNotification({
          token: user.fcmToken,
          title: "Auto Punch-Out",
          body: "You have been automatically punched out as you left the branch geo-fence area.",
          data: { action: "AUTO_PUNCH_OUT" }
        }).catch(err => console.error("FCM auto punch-out notification error:", err));
      }

      emitAttendanceUpdate(req, { userId, date, type: "PUNCH_OUT" });
      return res
        .status(200)
        .json({ success: true, data: attendance, message: reason });
    }

    // ── Main session (Session 1) ───────────────────────────────────────────
    if (attendance.punchOut?.time)
      return res.status(400).json({ message: "Already punched out" });

    attendance.punchOut = {
      time: timeString,
      location: { lat, lng, ...fixQuality(accuracy, null) },
    };
    attendance.totalHours = recomputeTotalHours(attendance);
    await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));

    await Promise.all([
      attendance.save(),
      User.findByIdAndUpdate(userId, { isTrackingActive: false }),
    ]);

    logPunchEvent({
      userId, branch, date, type: "AUTO_PUNCH_OUT", source: "GEOFENCE",
      timeString, sessionNumber: 1, lat, lng, accuracy,
    });

    if (user?.fcmToken) {
      fcmService.sendPushNotification({
        token: user.fcmToken,
        title: "Auto Punch-Out",
        body: "You have been automatically punched out as you left the branch geo-fence area.",
        data: { action: "AUTO_PUNCH_OUT" }
      }).catch(err => console.error("FCM auto punch-out notification error:", err));
    }

    res.status(200).json({ success: true, data: attendance, message: reason });
    emitAttendanceUpdate(req, { userId, date, type: "PUNCH_OUT" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error auto punching out", error: error.message });
  }
};

exports.checkGeoFence = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng)
      return res
        .status(400)
        .json({ success: false, message: "lat and lng required" });

    const userId = req.user.userId || req.user.id;
    const user = await User.findById(userId).populate("hrmsBranchId");
    const assignedBranch = user?.hrmsBranchId;

    if (
      !assignedBranch ||
      !assignedBranch.geoFenceEnabled ||
      !assignedBranch.latitude ||
      !assignedBranch.longitude
    ) {
      return res
        .status(200)
        .json({ success: true, inside: true, geoFenceEnabled: false });
    }

    let radiusM =
      typeof assignedBranch.radius === "number" ? assignedBranch.radius : 500;
    // radius is stored in metres (the branch form converts km→m on save)

    const distanceM = getDistanceFromLatLonInM(
      parseFloat(lat),
      parseFloat(lng),
      assignedBranch.latitude,
      assignedBranch.longitude,
    );
    const inside = distanceM !== null && distanceM <= radiusM;

    res.status(200).json({
      success: true,
      inside,
      geoFenceEnabled: true,
      distance: distanceM !== null ? Math.round(distanceM) : null,
      allowedRadius: radiusM,
      branchName: assignedBranch.name,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error checking geo-fence", error: error.message });
  }
};

exports.punchOut = async (req, res) => {
  try {
    const { lat, lng, accuracy, fixAt } = req.body;
    const date = getISTDate();
    const userId = req.user.userId || req.user.id;

    const [attendance, user] = await Promise.all([
      Attendance.findOne({ userId, date }),
      User.findById(userId)
        .select("fcmToken role hrmsBranchId")
        .populate("role", "role label")
        .populate("hrmsBranchId", "geoFenceEnabled latitude longitude radius radiusUnit name"),
    ]);
    if (!attendance) {
      return res
        .status(404)
        .json({ message: "No attendance record found for today" });
    }

    // State-machine guard: end the lunch break before punching out. Lunch must
    // be strictly nested inside a session (Lunch Out before Punch Out).
    if (isLunchOpen(attendance)) {
      return res.status(400).json({
        success: false,
        message: "Please end your lunch break before punching out.",
      });
    }

    // ── Geofence gate: punching out requires being at the branch ───────────
    // Field / sales / marketing roles are exempt — they roam by design and
    // must be able to punch out from anywhere.
    const assignedBranch = user?.hrmsBranchId;
    if (
      !isFieldRole(user) &&
      lat &&
      lng &&
      assignedBranch?.geoFenceEnabled &&
      assignedBranch?.latitude &&
      assignedBranch?.longitude
    ) {
      // A coarse fix (cell tower / WiFi — can be km off) must produce "retry
      // with better GPS", not a false denial. Same threshold as punch-in.
      const accuracyM = parseFloat(accuracy);
      if (!isNaN(accuracyM) && accuracyM > 150) {
        return res.status(403).json({
          success: false,
          message: `GPS accuracy is too poor (${Math.round(accuracyM)}m). Please step outside for a better GPS signal and try again.`,
        });
      }

      const radiusM =
        typeof assignedBranch.radius === "number" ? assignedBranch.radius : 500;
      const distanceM = getDistanceFromLatLonInM(
        lat,
        lng,
        assignedBranch.latitude,
        assignedBranch.longitude,
      );
      if (distanceM !== null && distanceM > radiusM) {
        return res.status(403).json({
          success: false,
          geoFenceViolation: true,
          distance: Math.round(distanceM),
          allowedRadius: radiusM,
          message: `You are outside the office location. Please return within the branch area of ${assignedBranch.name} to punch out.`,
        });
      }
    }

    const faceCheck = await checkSelfieFace(req, userId);
    if (faceCheck.blocked) {
      return res.status(403).json({ success: false, faceMismatch: true, message: faceCheck.blocked });
    }

    const sessions = attendance.sessions || [];
    const timeString = getISTTime();
    const punchOutAddress = await reverseGeocode(lat, lng);

    // ── Additional session punchOut (Sessions 2+) ──────────────────────────
    const openIdx = sessions.findIndex(
      (s) => s.punchIn?.time && !s.punchOut?.time,
    );

    if (openIdx !== -1) {
      // Selfie skipped for sessions 2+ — identity verified at Session 1.
      const openSession = sessions[openIdx];
      const sInMs = new Date(
        `${attendance.date}T${openSession.punchIn.time}`,
      ).getTime();
      const sOutMs = new Date(`${attendance.date}T${timeString}`).getTime();
      const durationMins = Math.max(0, Math.round((sOutMs - sInMs) / 60000));

      attendance.sessions[openIdx].punchOut = {
        time: timeString,
        selfieUrl: null,
        location: { lat, lng, address: punchOutAddress, ...fixQuality(accuracy, fixAt) },
      };
      attendance.sessions[openIdx].durationMins = durationMins;
      attendance.sessions[openIdx].closeReason = "manual";

      attendance.totalHours = recomputeTotalHours(attendance);
      await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));

      await Promise.all([
        attendance.save(),
        User.findByIdAndUpdate(userId, { isTrackingActive: false }),
      ]);

      logPunchEvent({
        userId, branch: assignedBranch, date, type: "PUNCH_OUT", source: punchEventSource(req),
        timeString, sessionNumber: openSession.sessionNumber, lat, lng, accuracy,
      });

      if (user?.fcmToken) {
        fcmService.sendPushNotification({
          token: user.fcmToken,
          title: "Punch Out Successful",
          body: `You ended session ${openSession.sessionNumber} successfully at ${format12Hour(timeString)}.`,
          data: { action: "PUNCH_OUT", sessionNumber: String(openSession.sessionNumber) }
        }).catch(err => console.error("FCM session-end notification error:", err));
      }

      emitAttendanceUpdate(req, { userId, date, type: "PUNCH_OUT" });
      return res.status(200).json({
        success: true,
        data: attendance,
        message: `Session ${openSession.sessionNumber} ended successfully.`,
      });
    }

    // ── Main session punchOut (Session 1) ──────────────────────────────────
    if (attendance.punchOut?.time) {
      return res.status(400).json({ message: "Already punched out for today" });
    }

    let selfieUrl = null;
    if (req.file) {
      try {
        selfieUrl = await uploadToCloudinary(req.file);
      } catch (uploadErr) {
        console.error("Cloudinary upload error:", uploadErr);
        return res.status(500).json({
          message: "Failed to upload selfie image",
          error: uploadErr.message,
        });
      }
    }

    attendance.punchOut = {
      time: timeString,
      selfieUrl,
      location: { lat, lng, address: punchOutAddress, ...fixQuality(accuracy, fixAt) },
    };
    attendance.totalHours = recomputeTotalHours(attendance);
    await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));

    await Promise.all([
      attendance.save(),
      User.findByIdAndUpdate(userId, { isTrackingActive: false }),
    ]);

    logPunchEvent({
      userId, branch: assignedBranch, date, type: "PUNCH_OUT", source: punchEventSource(req),
      timeString, sessionNumber: 1, lat, lng, accuracy,
    });

    if (user?.fcmToken) {
      fcmService.sendPushNotification({
        token: user.fcmToken,
        title: "Punch Out Successful",
        body: `You punched out successfully at ${format12Hour(timeString)}.`,
        data: { action: "PUNCH_OUT" }
      }).catch(err => console.error("FCM punch-out notification error:", err));
    }

    res.status(200).json({
      success: true,
      data: attendance,
      message: "Punched out successfully",
    });
    emitAttendanceUpdate(req, { userId, date, type: "PUNCH_OUT" });
  } catch (error) {
    console.error("Punch Out Error:", error);
    res
      .status(500)
      .json({ message: "Error punching out", error: error.message });
  }
};

exports.lunchIn = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const date = getISTDate();

    const userId = req.user.userId || req.user.id;

    const [attendance, user] = await Promise.all([
      Attendance.findOne({ userId, date }),
      User.findById(userId)
        .select("role hrmsBranchId")
        .populate("role", "role label")
        .populate("hrmsBranchId", "geoFenceEnabled latitude longitude radius radiusUnit name"),
    ]);
    if (!attendance) {
      return res
        .status(404)
        .json({ message: "No attendance record found for today" });
    }

    // ── State-machine guard ────────────────────────────────────────────────
    // Lunch can only start INSIDE an open session (must be punched in, not yet
    // punched out) and only one lunch break is supported per day. This blocks
    // the orphaned-lunch case (lunch recorded after a punch-out) and prevents a
    // second lunchIn from silently overwriting the first.
    if (!hasOpenSession(attendance)) {
      return res.status(400).json({
        success: false,
        message: "You must be punched in to start a lunch break.",
      });
    }
    if (isLunchOpen(attendance)) {
      return res.status(400).json({
        success: false,
        message: "A lunch break is already in progress. Please end it first.",
      });
    }
    if (attendance.lunchIn?.time) {
      return res.status(400).json({
        success: false,
        message: "A lunch break has already been recorded for today.",
      });
    }

    // ── Geofence gate: starting lunch requires being at the branch ─────────
    // Same gate as lunch-out / punch-out. Field/sales/marketing roles are
    // exempt — they roam by design.
    const assignedBranch = user?.hrmsBranchId;
    if (
      !isFieldRole(user) &&
      lat &&
      lng &&
      assignedBranch?.geoFenceEnabled &&
      assignedBranch?.latitude &&
      assignedBranch?.longitude
    ) {
      const accuracyM = parseFloat(accuracy);
      if (!isNaN(accuracyM) && accuracyM > 150) {
        return res.status(403).json({
          success: false,
          message: `GPS accuracy is too poor (${Math.round(accuracyM)}m). Please step outside for a better GPS signal and try again.`,
        });
      }

      const radiusM =
        typeof assignedBranch.radius === "number" ? assignedBranch.radius : 500;
      const distanceM = getDistanceFromLatLonInM(
        lat,
        lng,
        assignedBranch.latitude,
        assignedBranch.longitude,
      );
      if (distanceM !== null && distanceM > radiusM) {
        return res.status(403).json({
          success: false,
          geoFenceViolation: true,
          distance: Math.round(distanceM),
          allowedRadius: radiusM,
          message: `You are outside the office location. Please be within the branch area of ${assignedBranch.name} to start your lunch break.`,
        });
      }
    }

    const lunchInAddress = await reverseGeocode(lat, lng);
    attendance.lunchIn = {
      time: getISTTime(),
      selfieUrl: null, // no selfie required for lunch
      location: { lat, lng, address: lunchInAddress },
    };

    await attendance.save();
    res
      .status(200)
      .json({ success: true, data: attendance, message: "Lunch started" });
  } catch (error) {
    console.error("Lunch In Error:", error);
    res
      .status(500)
      .json({ message: "Error recording lunch in", error: error.message });
  }
};

exports.lunchOut = async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    const date = getISTDate();

    const userId = req.user.userId || req.user.id;

    const [attendance, user] = await Promise.all([
      Attendance.findOne({ userId, date }),
      User.findById(userId)
        .select("role hrmsBranchId")
        .populate("role", "role label")
        .populate("hrmsBranchId", "geoFenceEnabled latitude longitude radius radiusUnit name"),
    ]);
    if (!attendance) {
      return res
        .status(404)
        .json({ message: "No attendance record found for today" });
    }

    // ── State-machine guard: can only end a lunch break that is in progress ─
    if (!isLunchOpen(attendance)) {
      return res.status(400).json({
        success: false,
        message: attendance.lunchOut?.time
          ? "Your lunch break has already ended."
          : "No lunch break is in progress to end.",
      });
    }

    // ── Geofence gate: ending lunch requires being back at the branch ──────
    // Mirrors the punch-out gate. Field/sales/marketing roles are exempt —
    // they roam by design.
    const assignedBranch = user?.hrmsBranchId;
    if (
      !isFieldRole(user) &&
      lat &&
      lng &&
      assignedBranch?.geoFenceEnabled &&
      assignedBranch?.latitude &&
      assignedBranch?.longitude
    ) {
      const accuracyM = parseFloat(accuracy);
      if (!isNaN(accuracyM) && accuracyM > 150) {
        return res.status(403).json({
          success: false,
          message: `GPS accuracy is too poor (${Math.round(accuracyM)}m). Please step outside for a better GPS signal and try again.`,
        });
      }

      const radiusM =
        typeof assignedBranch.radius === "number" ? assignedBranch.radius : 500;
      const distanceM = getDistanceFromLatLonInM(
        lat,
        lng,
        assignedBranch.latitude,
        assignedBranch.longitude,
      );
      if (distanceM !== null && distanceM > radiusM) {
        return res.status(403).json({
          success: false,
          geoFenceViolation: true,
          distance: Math.round(distanceM),
          allowedRadius: radiusM,
          message: `You are outside the office location. Please return within the branch area of ${assignedBranch.name} to end your lunch break.`,
        });
      }
    }

    const lunchOutAddress = await reverseGeocode(lat, lng);
    attendance.lunchOut = {
      time: getISTTime(),
      selfieUrl: null, // no selfie required for lunch
      location: { lat, lng, address: lunchOutAddress },
    };

    // Stamp the real break length + over-limit flag now, so the admin views can
    // flag a long lunch immediately (punch-out finalize recomputes it anyway).
    const shiftDoc = await loadShiftForFinalize(attendance);
    attendance.lunchMinutes = actualLunchMinutes(attendance);
    const cfgLunch = configuredLunchMinutes(shiftDoc);
    attendance.lunchOverLimit = cfgLunch > 0 && attendance.lunchMinutes > cfgLunch;

    await attendance.save();
    res
      .status(200)
      .json({ success: true, data: attendance, message: "Lunch ended" });
  } catch (error) {
    console.error("Lunch Out Error:", error);
    res
      .status(500)
      .json({ message: "Error recording lunch out", error: error.message });
  }
};

exports.getTodayAttendance = async (req, res) => {
  try {
    const date = getISTDate();

    const userId = req.user.userId || req.user.id;

    const attendance = await Attendance.findOne({ userId, date });
    res.status(200).json({ success: true, data: attendance });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching attendance", error: error.message });
  }
};

// GET /attendance/events/today — chronological punch-event log for the
// employee's "Today's Activity" list.
exports.getTodayEvents = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const date = getISTDate();
    const events = await AttendanceEvent.find({ employeeId: userId, date })
      .sort({ at: 1 })
      .populate("branchId", "name")
      .lean();
    const data = events.map((e) => ({
      ...e,
      branchName: e.branchId?.name || null,
    }));
    res.status(200).json({ success: true, data });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching attendance events", error: error.message });
  }
};

exports.getAttendanceHistory = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { month, year } = req.query;
    let query = { userId };

    if (month && year) {
      // Build "YYYY-MM-DD" bounds directly — the `date` field is a plain string.
      // Do NOT go through Date.toISOString(): on a server ahead of UTC (e.g. IST)
      // that shifts the boundary back a day and drops the month's last day.
      const y = Number(year);
      const m = Number(month);
      const pad = (n) => String(n).padStart(2, "0");
      const lastDay = new Date(y, m, 0).getDate(); // day-count is timezone-safe
      query.date = {
        $gte: `${y}-${pad(m)}-01`,
        $lte: `${y}-${pad(m)}-${pad(lastDay)}`,
      };
    }

    const history = await Attendance.find(query).sort({ date: -1 });
    res.status(200).json({ success: true, data: history });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching history", error: error.message });
  }
};

// ── Helper: compute the "effective" display status from a record ──────────────
// Mirrors the frontend getEffectiveStatus() exactly. Three real statuses exist:
// Full Day (worked >= full shift), Half Day (any completed punch under that),
// Absent — finalized at punch-out by finalizeAttendanceStatus() (utils/
// shiftStatus.js) and read straight off att.status here. "On Duty" is a
// live-only label for a day still in progress (today, not yet punched out);
// it is never persisted. A past day that was never completed (no punch-out,
// or an open session left hanging) reads back as Absent until an admin
// corrects it. Lateness is a separate flag (att.lateMinutes > 0), not a
// status — callers that need it should read that field directly.
function computeEffectiveStatus(att, dateStr) {
  const todayStr = getISTDate();
  const isToday = dateStr === todayStr || att.date === todayStr;

  const hasPunchIn = att.punchIn?.time || att.punchIn;
  // Root punchOut only closes Session 1 — an open additional session means
  // the employee is still on duty even though root punchOut is set.
  const hasOpenSession = (att.sessions || []).some(
    (s) => s.punchIn?.time && !s.punchOut?.time,
  );
  const hasPunchOut = (att.punchOut?.time || att.punchOut) && !hasOpenSession;

  if (!hasPunchIn) return "Absent";
  if (!hasPunchOut) return isToday ? "On Duty" : "Absent";

  return att.status || "Absent";
}

exports.getAllAttendance = async (req, res) => {
  try {
    const {
      userId,
      employeeId,
      date,
      storeId,
      hrmsBranchId,
      shiftId,
      month,
      year,
      regularizationRequested,
      status,
      approvalStatus,
      statusFilter,   // Full Day | Half Day | Late | On Duty | Missing | Short | Absent
      page,
      limit,
    } = req.query;

    const mongoose = require("mongoose");

    // ── Absent: employees with NO attendance record on the given date ─────────
    // Absent employees have zero DB records — must compare Users vs Attendance.
    if (statusFilter === "Absent") {
      const targetDate = date || getISTDate();

      // Only fetch active employees who need attendance tracking
      const empQuery = {
        isActive: true,
        attendanceRequired: { $ne: false },
      };
      if (!req.user?.is_superadmin) {
        empQuery.tenant_id = req.user?.tenant_id || null;
      }
      if (storeId) {
        empQuery.storeId = mongoose.Types.ObjectId.isValid(storeId)
          ? new mongoose.Types.ObjectId(storeId)
          : storeId;
      }
      if (hrmsBranchId) {
        empQuery.hrmsBranchId = mongoose.Types.ObjectId.isValid(hrmsBranchId)
          ? new mongoose.Types.ObjectId(hrmsBranchId)
          : hrmsBranchId;
      }
      if (shiftId) {
        empQuery.shiftId = mongoose.Types.ObjectId.isValid(shiftId)
          ? new mongoose.Types.ObjectId(shiftId)
          : shiftId;
      }

      // Branch supervisors: only their branches' staff.
      const scopeFilter = await scopedUserFilter(req);
      if (Object.keys(scopeFilter).length) empQuery.$and = [scopeFilter];

      const presentQuery = { date: targetDate };
      if (!req.user?.is_superadmin) {
        const tenantUsers = await User.find({ tenant_id: req.user?.tenant_id || null }).select("_id");
        const tenantUserIds = tenantUsers.map((u) => u._id);
        presentQuery.userId = { $in: tenantUserIds };
      }

      const [allEmployees, presentRecords] = await Promise.all([
        User.find(empQuery)
          .select("name email mobile avatar role storeId hrmsBranchId")
          .populate("role", "label")
          .populate("storeId", "name")
          .limit(2000),
        Attendance.find(presentQuery).select("userId punchIn.time punchOut.time date").lean(),
      ]);

      const presentIds = new Set(
        presentRecords.filter((r) => isPresentRecord(r, targetDate)).map((r) => String(r.userId))
      );
      const absentEmployees = allEmployees.filter(
        (e) => !presentIds.has(String(e._id))
      );
      return res.status(200).json({ success: true, data: absentEmployees, date: targetDate });
    }

    // ── All other filters: query the Attendance collection ───────────────────
    const query = {};

    if (userId) query.userId = userId;
    if (employeeId) query.userId = employeeId;

    if (!req.user?.is_superadmin) {
      const tenantUsers = await User.find({ tenant_id: req.user?.tenant_id || null }).select("_id");
      const tenantUserIds = tenantUsers.map((u) => u._id);
      if (query.userId) {
        if (!tenantUserIds.map(String).includes(String(query.userId))) {
          return res.status(200).json({ success: true, data: [] });
        }
      } else {
        query.userId = { $in: tenantUserIds };
      }
    }

    // Branch supervisors: narrow to their branches' staff (+ themselves).
    const allowedIds = await scopedUserIds(req);
    if (allowedIds) {
      if (query.userId && typeof query.userId !== "object") {
        if (!allowedIds.some((id) => String(id) === String(query.userId))) {
          return res.status(200).json({ success: true, data: [] });
        }
      } else {
        query.userId = { $in: allowedIds };
      }
    }

    if (regularizationRequested === "true")
      query.regularizationRequested = true;
    if (approvalStatus) query.approvalStatus = approvalStatus;

    // Legacy ?status= still works (maps to the DB status field)
    if (status && !statusFilter) query.status = status;

    if (date) {
      query.date = date;
    } else if (month && year) {
      // Build "YYYY-MM-DD" bounds directly — the `date` field is a plain string.
      // Do NOT go through Date.toISOString(): on a server ahead of UTC (e.g. IST)
      // that shifts the boundary back a day and drops the month's last day.
      const y = Number(year);
      const m = Number(month);
      const pad = (n) => String(n).padStart(2, "0");
      const lastDay = new Date(y, m, 0).getDate(); // day-count is timezone-safe
      query.date = {
        $gte: `${y}-${pad(m)}-01`,
        $lte: `${y}-${pad(m)}-${pad(lastDay)}`,
      };
    }

    if (storeId) {
      const isValidObjectId = mongoose.Types.ObjectId.isValid(storeId);
      const storeUsers = await User.find({ storeId }).select("_id");
      const userIds = storeUsers.map((u) => u._id);

      const conditions = [{ userId: { $in: userIds } }];
      if (isValidObjectId) {
        conditions.push({ storeId: new mongoose.Types.ObjectId(storeId) });
      } else {
        conditions.push({ storeId: storeId });
      }
      query.$or = conditions;
    }

    if (hrmsBranchId) {
      const isValidObjectId = mongoose.Types.ObjectId.isValid(hrmsBranchId);
      const branchUsers = await User.find({ hrmsBranchId }).select("_id");
      const userIds = branchUsers.map((u) => u._id);

      const conditions = [{ userId: { $in: userIds } }];
      if (isValidObjectId) {
        conditions.push({ hrmsBranchId: new mongoose.Types.ObjectId(hrmsBranchId) });
      } else {
        conditions.push({ hrmsBranchId });
      }
      query.$or = conditions;
    }

    if (shiftId) {
      query.shiftId = shiftId;
    }

    // Late is a flag (lateMinutes > 0), not a status, so it filters
    // independently of Full Day / Half Day / Absent.
    if (statusFilter === "Late") {
      query.lateMinutes = { $gt: 0 };
    } else if (statusFilter === "On Duty") {
      // Live-only: today, punched in, not yet punched out.
      const todayStr = getISTDate();
      if (!date) query.date = todayStr;
      query["punchIn.time"] = { $exists: true, $ne: null };
      query["punchOut.time"] = { $exists: false };
    } else if (statusFilter === "Full Day" || statusFilter === "Half Day") {
      // Finalized at punch-out (see finalizeAttendanceStatus) — filters directly at the DB.
      query.status = statusFilter;
    }

    // Opt-in pagination: only paginate when page/limit is explicitly sent —
    // no current caller sends either, so the default (both undefined) keeps
    // the exact legacy unbounded response shape.
    const isPaginated = page !== undefined || limit !== undefined;

    if (!isPaginated) {
      const records = await Attendance.find(query)
        .populate({
          path: "userId",
          select: "name email mobile avatar role storeId",
          populate: [
            { path: "role", select: "label" },
            { path: "storeId", select: "name" },
          ],
        })
        .populate("storeId", "name")
        .sort({ date: -1, "punchIn.time": -1 });

      // A completed-but-uncorrected day (open session / missing punch-out on a
      // past date) never got a finalized status — surface it as Absent here
      // instead of leaving it stuck at null.
      let filtered = records;
      if (statusFilter === "Absent") {
        filtered = records.filter(
          (r) => computeEffectiveStatus(r, date || null) === "Absent"
        );
      }

      return res.status(200).json({ success: true, data: filtered });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, records] = await Promise.all([
      Attendance.countDocuments(query),
      Attendance.find(query)
        .populate({
          path: "userId",
          select: "name email mobile avatar role storeId",
          populate: [
            { path: "role", select: "label" },
            { path: "storeId", select: "name" },
          ],
        })
        .populate("storeId", "name")
        .sort({ date: -1, "punchIn.time": -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    // A completed-but-uncorrected day (open session / missing punch-out on a
    // past date) never got a finalized status — surface it as Absent here
    // instead of leaving it stuck at null. This re-filters only the current
    // page's rows; acceptable since this branch only fires when `date` is
    // set (a single day, small result set).
    let filtered = records;
    if (statusFilter === "Absent") {
      filtered = records.filter(
        (r) => computeEffectiveStatus(r, date || null) === "Absent"
      );
    }

    res.status(200).json({
      success: true,
      data: filtered,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching all attendance", error: error.message });
  }
};

exports.requestRegularization = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const attendance = await Attendance.findById(id);
    if (!attendance)
      return res.status(404).json({ message: "Attendance not found" });

    attendance.regularizationRequested = true;
    attendance.regularizationReason = reason;
    attendance.approvalStatus = "pending";
    await attendance.save();

    res.status(200).json({
      success: true,
      data: attendance,
      message: "Regularization requested",
    });
  } catch (error) {
    res.status(500).json({
      message: "Error requesting regularization",
      error: error.message,
    });
  }
};

exports.approveAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const attendance = await Attendance.findById(id);
    if (!attendance)
      return res.status(404).json({ message: "Attendance not found" });
    if (!(await canActOnEmployee(req, attendance.userId, ["view_attendance"])))
      return res.status(403).json({ message: OUT_OF_SCOPE_MESSAGE });

    attendance.approvalStatus = "approved";
    attendance.approvedBy = req.user.userId || req.user.id;
    // Regularization approval doesn't change hours worked — just re-finalize
    // against the assigned shift so status reflects the (possibly corrected)
    // punch times rather than being forced to a fixed value.
    if (attendance.punchIn?.time && attendance.punchOut?.time) {
      await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));
    }
    await attendance.save();

    res.status(200).json({
      success: true,
      data: attendance,
      message: "Attendance approved",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error approving attendance", error: error.message });
  }
};

exports.rejectAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const attendance = await Attendance.findById(id);
    if (!attendance)
      return res.status(404).json({ message: "Attendance not found" });
    if (!(await canActOnEmployee(req, attendance.userId, ["view_attendance"])))
      return res.status(403).json({ message: OUT_OF_SCOPE_MESSAGE });

    attendance.approvalStatus = "rejected";
    attendance.approvedBy = req.user.userId || req.user.id;
    await attendance.save();

    res.status(200).json({
      success: true,
      data: attendance,
      message: "Attendance rejected",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error rejecting attendance", error: error.message });
  }
};

exports.getAttendanceById = async (req, res) => {
  try {
    const { id } = req.params;
    const attendance = await Attendance.findById(id)
      .populate({
        path: "userId",
        select: "name email mobile avatar role storeId department tenant_id",
        populate: [
          { path: "role", select: "label" },
          { path: "storeId", select: "name" },
        ],
      })
      .populate("shiftId")
      .populate("storeId")
      .populate("approvedBy", "name");

    if (!attendance)
      return res.status(404).json({ message: "Attendance not found" });

    // Enforce Multi-Tenant Isolation
    const reqTenantId = req.user?.is_superadmin ? null : req.user?.tenant_id;
    const userTenantId = attendance.userId?.tenant_id;
    if (reqTenantId && userTenantId && String(reqTenantId) !== String(userTenantId)) {
      return res.status(403).json({ success: false, message: "Access denied. Cross-tenant access is prohibited." });
    }

    // Enforce Role-Based Access Control
    const isAdmin = await isTenantAdmin(req);
    const currentEmpId = req.user?.userId || req.user?.id || req.user?._id;
    const isOwn = currentEmpId && String(attendance.userId?._id || attendance.userId) === String(currentEmpId);
    const canAct = await canActOnEmployee(req, attendance.userId?._id || attendance.userId);

    if (!isAdmin && !isOwn && !canAct) {
      return res.status(403).json({ success: false, message: OUT_OF_SCOPE_MESSAGE });
    }

    res.status(200).json({ success: true, data: attendance });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching attendance details",
      error: error.message,
    });
  }
};

// Thrown by applyAdminCorrection for bad input — carries the HTTP status.
class CorrectionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Shared by the single "Correct" dialog and the bulk offline import: creates
// or updates one employee-day as an admin entry and recomputes hours, status,
// overtime, early-out and late minutes exactly like a live punch would.
async function applyAdminCorrection(req, { userId, date, punchInTime, punchOutTime, lunchInTime, lunchOutTime, note, statusOverride }) {
    const adminId = req.user.userId || req.user.id;

    if (statusOverride && !["Full Day", "Half Day", "Absent"].includes(statusOverride)) {
      throw new CorrectionError(400, "statusOverride must be one of Full Day, Half Day, Absent");
    }

    if (!userId || !date || (!punchInTime && !punchOutTime && !statusOverride)) {
      throw new CorrectionError(400, "userId, date, and at least one of punchInTime/punchOutTime/statusOverride are required");
    }
    if (!isRealDate(date)) throw new CorrectionError(400, "date must be a real date in YYYY-MM-DD format");
    if (date > getISTDate()) throw new CorrectionError(400, "Attendance cannot be corrected for a future date");

    if (!(await canActOnEmployee(req, userId, ["view_attendance"]))) {
      throw new CorrectionError(403, OUT_OF_SCOPE_MESSAGE);
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (punchInTime && !timeRegex.test(punchInTime))
      throw new CorrectionError(400, "punchInTime must be HH:mm");
    if (punchOutTime && !timeRegex.test(punchOutTime))
      throw new CorrectionError(400, "punchOutTime must be HH:mm");
    if (punchInTime && punchOutTime && punchInTime >= punchOutTime) {
      throw new CorrectionError(400, "Punch-in must be before punch-out");
    }
    // Lunch (optional) — must be a complete pair inside the punch-in/out window.
    if (!!lunchInTime !== !!lunchOutTime)
      throw new CorrectionError(400, "Enter both Lunch In and Lunch Out, or leave both blank");
    if (lunchInTime) {
      if (!timeRegex.test(lunchInTime)) throw new CorrectionError(400, "lunchInTime must be HH:mm");
      if (!timeRegex.test(lunchOutTime)) throw new CorrectionError(400, "lunchOutTime must be HH:mm");
      if (lunchInTime >= lunchOutTime) throw new CorrectionError(400, "Lunch In must be before Lunch Out");
      if (punchInTime && lunchInTime < punchInTime) throw new CorrectionError(400, "Lunch In must be after Punch In");
      if (punchOutTime && lunchOutTime > punchOutTime) throw new CorrectionError(400, "Lunch Out must be before Punch Out");
    }

    const inTime = punchInTime ? `${punchInTime}:00` : null;
    const outTime = punchOutTime ? `${punchOutTime}:00` : null;

    let attendance = await Attendance.findOne({ userId, date });

    if (!attendance) {
      const user = await User.findById(userId).select("storeId shiftId");
      attendance = new Attendance({
        userId,
        date,
        source: "admin",
        approvalStatus: "approved",
        approvedBy: adminId,
        notes: note?.trim() || "",
        storeId: user?.storeId || null,
        shiftId: user?.shiftId || null,
      });
    }

    if (inTime) attendance.set("punchIn.time", inTime);
    if (outTime) attendance.set("punchOut.time", outTime);
    if (lunchInTime) {
      attendance.set("lunchIn.time", `${lunchInTime}:00`);
      attendance.set("lunchOut.time", `${lunchOutTime}:00`);
      // Same stamping as a live lunch-out punch (drives the "Long Lunch" badge).
      attendance.lunchMinutes = actualLunchMinutes(attendance);
      const cfgLunch = configuredLunchMinutes(await loadShiftForFinalize(attendance));
      attendance.lunchOverLimit = cfgLunch > 0 && attendance.lunchMinutes > cfgLunch;
    }
    attendance.source = "admin";
    attendance.notes = note?.trim() || "";
    attendance.approvedBy = adminId;
    attendance.approvalStatus = "approved";

    if (statusOverride) {
      // Every other place in the app (the "Absent" list, the effective-status
      // helper, payroll day-counting) decides present-vs-absent purely from
      // whether punchIn/punchOut exist — status alone isn't enough. Without
      // synthesized punch times, overriding an absent day to "Full Day" would
      // set attendance.status correctly but the record would still look
      // absent everywhere else. Fill in whichever end is missing using the
      // assigned shift (or a 09:00 default) so the record is self-consistent.
      if (!attendance.punchIn?.time || !attendance.punchOut?.time) {
        const shiftDoc = attendance.shiftId
          ? await Shift.findById(attendance.shiftId).select("startTime endTime").lean()
          : null;
        const shiftHours = getShiftDurationHours(shiftDoc);
        const desiredHours =
          statusOverride === "Full Day" ? shiftHours
            : statusOverride === "Half Day" ? shiftHours / 2
              : 0; // Absent
        const pad = (n) => String(n).padStart(2, "0");

        if (!attendance.punchIn?.time) {
          attendance.set("punchIn.time", `${shiftDoc?.startTime || "09:00"}:00`);
        }
        if (!attendance.punchOut?.time) {
          const [sh, sm] = attendance.punchIn.time.split(":").map(Number);
          const endMins = sh * 60 + sm + Math.round(desiredHours * 60);
          attendance.set("punchOut.time", `${pad(Math.floor(endMins / 60) % 24)}:${pad(endMins % 60)}:00`);
        }
      }
      attendance.totalHours = recomputeTotalHours(attendance);
      // Admin is directly setting the day's status (e.g. Half Day -> Full
      // Day) — trust that explicit call instead of re-deriving from hours.
      attendance.status = statusOverride;
    } else {
      // Single source of truth — same function used by every other punchOut path
      attendance.totalHours = recomputeTotalHours(attendance);
      if (attendance.punchIn?.time && attendance.punchOut?.time) {
        // Only finalize once both ends of the day are known — an admin
        // setting just a punch-in (no punch-out yet) shouldn't get stamped
        // Half Day off zero hours worked.
        await finalizeAttendanceStatus(attendance, await loadShiftForFinalize(attendance));
      }
    }

    // Overtime and late-minutes are independent of the Full/Half classification
    // and MUST be (re)computed on any correction that has a completed punch
    // pair — including the statusOverride branch, which skips
    // finalizeAttendanceStatus. Without this an admin-entered day that runs
    // past shift end shows 0 overtime and 0 late minutes, so payroll silently
    // under-pays OT and the late-allowance override never triggers.
    if (attendance.punchIn?.time && attendance.punchOut?.time) {
      const shiftDoc = await loadShiftForFinalize(attendance);
      attendance.overtimeMinutes = computeOvertimeMinutes(attendance, shiftDoc);
      attendance.earlyOutMinutes = computeEarlyOutMinutes(attendance, shiftDoc);
      if (shiftDoc?.startTime) {
        const [sh, sm] = shiftDoc.startTime.split(":").map(Number);
        const [ph, pm] = attendance.punchIn.time.split(":").map(Number);
        const diff = ph * 60 + pm - (sh * 60 + sm);
        attendance.lateMinutes = diff > (shiftDoc.lateGraceMinutes || 0) ? diff : 0;
      }
    }

    await attendance.save();
    return attendance;
}

exports.adminCorrectPunch = async (req, res) => {
  try {
    const attendance = await applyAdminCorrection(req, req.body);
    return res.json({
      success: true,
      data: attendance,
      message: "Attendance corrected",
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// POST /attendance/import — offline attendance (Wi-Fi down, power cut, kiosk
// unavailable…) kept on paper/register and entered later from Excel.
// Body: { rows: [{ employee, date: "YYYY-MM-DD", punchIn?, punchOut?, lunchIn?, lunchOut? ("HH:mm"), status?, note? }] }
// `employee` matches Employee Code, then email, then mobile, then exact name,
// always within the admin's own tenant. Each row is applied independently via
// applyAdminCorrection, so one bad row never blocks the rest.
exports.importAttendance = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, message: "No rows to import" });
    if (rows.length > 5000) return res.status(400).json({ success: false, message: "Maximum 5000 rows per import" });

    const tenantFilter = req.user?.is_superadmin ? {} : { tenant_id: req.user?.tenant_id || null };
    const users = await User.find(tenantFilter).select("_id name email mobile employeeCode").lean();
    const norm = (v) => String(v ?? "").trim().toLowerCase();
    const byCode = new Map(), byEmail = new Map(), byMobile = new Map(), byName = new Map();
    for (const u of users) {
      if (u.employeeCode) byCode.set(norm(u.employeeCode), u);
      if (u.email) byEmail.set(norm(u.email), u);
      if (u.mobile) byMobile.set(String(u.mobile).replace(/\D/g, "").slice(-10), u);
      const n = norm(u.name);
      if (n) byName.set(n, byName.has(n) ? null : u); // null = ambiguous name
    }
    const findUser = (key) => {
      const k = norm(key);
      if (!k) return undefined;
      const digits = k.replace(/\D/g, "");
      return byCode.get(k) || byEmail.get(k) || (digits.length >= 10 ? byMobile.get(digits.slice(-10)) : undefined) || byName.get(k);
    };

    const today = getISTDate();
    const results = [];
    let success = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowNo = r.rowNumber || i + 2;
      try {
        const user = findUser(r.employee);
        if (user === null) throw new CorrectionError(400, `"${r.employee}" matches more than one employee — use Employee Code or Email`);
        if (!user) throw new CorrectionError(400, `Employee "${r.employee || ""}" not found`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ""))) throw new CorrectionError(400, "Date must be a valid date");
        if (r.date > today) throw new CorrectionError(400, "Date cannot be in the future");
        await applyAdminCorrection(req, {
          userId: user._id,
          date: r.date,
          punchInTime: r.punchIn || undefined,
          punchOutTime: r.punchOut || undefined,
          lunchInTime: r.lunchIn || undefined,
          lunchOutTime: r.lunchOut || undefined,
          statusOverride: r.status || undefined,
          note: r.note ? String(r.note) : "Imported offline attendance",
        });
        success++;
        results.push({ row: rowNo, employee: user.name, date: r.date, ok: true });
      } catch (e) {
        results.push({ row: rowNo, employee: r.employee || "", date: r.date || "", ok: false, error: e.message });
      }
    }

    return res.json({ success: true, data: { total: rows.length, success, failed: rows.length - success, results } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAbsentEmployees = async (req, res) => {
  try {
    const { date, storeId, hrmsBranchId, shiftId } = req.query;
    const targetDate = date || getISTDate();

    const mongoose = require("mongoose");
    // Fetch active employees who need attendance tracking
    const empQuery = {
      isActive: true,
      attendanceRequired: { $ne: false },
    };
    if (!req.user?.is_superadmin) {
      empQuery.tenant_id = req.user?.tenant_id || null;
    }
    if (storeId) {
      empQuery.storeId = mongoose.Types.ObjectId.isValid(storeId)
        ? new mongoose.Types.ObjectId(storeId)
        : storeId;
    }
    if (hrmsBranchId) {
      empQuery.hrmsBranchId = mongoose.Types.ObjectId.isValid(hrmsBranchId)
        ? new mongoose.Types.ObjectId(hrmsBranchId)
        : hrmsBranchId;
    }
    if (shiftId) {
      empQuery.shiftId = mongoose.Types.ObjectId.isValid(shiftId)
        ? new mongoose.Types.ObjectId(shiftId)
        : shiftId;
    }

    // Branch supervisors: only their branches' staff.
    const scopeFilter = await scopedUserFilter(req);
    if (Object.keys(scopeFilter).length) empQuery.$and = [scopeFilter];

    const presentQuery = { date: targetDate };
    if (!req.user?.is_superadmin) {
      const tenantUsers = await User.find({ tenant_id: req.user?.tenant_id || null }).select("_id");
      const tenantUserIds = tenantUsers.map((u) => u._id);
      presentQuery.userId = { $in: tenantUserIds };
    }

    const [allEmployees, presentRecords] = await Promise.all([
      User.find(empQuery)
        .select("name email mobile avatar role storeId hrmsBranchId")
        .populate("role", "label")
        .populate("storeId", "name")
        .limit(2000),
      Attendance.find(presentQuery).select("userId punchIn.time punchOut.time date").lean(),
    ]);

    const presentIds = new Set(
      presentRecords.filter((r) => isPresentRecord(r, targetDate)).map((r) => String(r.userId))
    );
    const absentEmployees = allEmployees.filter(
      (e) => !presentIds.has(String(e._id))
    );

    res.status(200).json({ success: true, data: absentEmployees, date: targetDate });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching absent employees", error: error.message });
  }
};
