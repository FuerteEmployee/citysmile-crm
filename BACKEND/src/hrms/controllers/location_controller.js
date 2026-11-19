const EmployeeRoute = require("../models/employee_route_model");
const Attendance   = require("../models/attendance_model");
const User         = require("../models/user_model");
const Shift        = require("../models/shift_model");
const jwt          = require("jsonwebtoken");
const axios        = require("axios");
const { checkNumber } = require("../utils/fieldRules");

// A GPS point the map can actually draw: numeric lat in -90..90, lng in -180..180.
const isValidPoint = (p) =>
  typeof p.lat === "number" && typeof p.lng === "number" &&
  !checkNumber("lat", p.lat, { min: -90, max: 90 }) && !checkNumber("lng", p.lng, { min: -180, max: 180 });

// Lifetime of the background-tracking token. Must comfortably outlast a single
// work shift so points keep syncing even if the app is killed all day. The
// login token is only "1d" and is minted at login (not punch-in), so it can
// expire mid-shift — this dedicated token avoids that. Re-minted on every
// startTracking() call, so it effectively refreshes each time tracking starts.
const TRACKING_TOKEN_TTL = "36h";
const { smoothPath } = require("../utils/kalmanFilter");
const simplify       = require("simplify-js");
const { detectStops, computeRouteDistance, buildReducedPath } = require("../utils/stopDetection");
const {
  recordFix, recordReplayFix, findHistoricalExit, clearFixes, medianOutside,
  GEOFENCE_WINDOW_MIN, GEOFENCE_GRACE_MS,
} = require("../utils/geofenceWindow");
const { reverseGeocode } = require("../utils/geocode");
const { computeTotalHours, finalizeAttendanceStatus } = require("../utils/shiftStatus");
const { logAttendanceEvent } = require("../utils/attendance_event_logger");

// IST wall-clock strings for an arbitrary instant (replay closes sessions at
// HISTORICAL times, not "now").
const istTimeOf = (ms) =>
  new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
const istDateOf = (ms) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const GeofenceAudit = require("../models/geofence_audit_model");
const { getISTDate, getISTTime } = require("../utils/timeUtils");

// Was a separate duplicate of attendance_controller.js's recomputeTotalHours
// (with a real divergence — truthy vs !==null checks). Now a thin alias for
// the shared implementation in utils/shiftStatus.js.
function _computeTotalHours(attendance) {
  return computeTotalHours(attendance);
}

// Loads the shift fields finalizeAttendanceStatus needs. See identical helper
// in attendance_controller.js — the shared logic itself lives in
// utils/shiftStatus.js so the two controllers can't drift out of sync again.
async function _loadShiftForFinalize(attendance) {
  if (!attendance.shiftId) return null;
  return Shift.findById(attendance.shiftId)
    .select("startTime endTime overtimeGraceMinutes earlyOutGraceMinutes overtimeRatePerHour allowedLateCountPerMonth lunch")
    .lean();
}

// ── Background geofence check ───────────────────────────────────────────────
// Called after every location update. If the employee is punched in and the
// windowed-median position is clearly outside their branch geofence, auto
// punch-out is triggered server-side — no app interaction required.
// points: [{ lat, lng, accuracy, trackedAtMs }] — every fix carried by the
// request, each recorded with its CLIENT capture time so stale offline-queue
// flushes can't masquerade as live evidence.
async function _checkGeofenceAndAutoPunchOut(userId, points, io) {
  try {
    if (!Array.isArray(points) || points.length === 0) return;
    const user = await User.findById(userId)
      .populate("role", "role label")
      .populate("hrmsBranchId", "geoFenceEnabled latitude longitude radius radiusUnit");

    // Skip field / sales / marketing roles
    const roleKey   = (user?.role?.role  || "").toLowerCase();
    const roleLabel = (user?.role?.label || "").toLowerCase();
    if (
      roleKey.includes("field") || roleKey.includes("sales") ||
      roleKey.includes("marketing_executive") ||
      roleLabel.includes("field executive") || roleLabel.includes("marketing executive") ||
      roleLabel.includes("field staff")
    ) {
      clearFixes(userId);
      return;
    }

    const branch = user?.hrmsBranchId;
    if (!branch?.geoFenceEnabled || !branch?.latitude || !branch?.longitude) {
      clearFixes(userId);
      return;
    }

    // Geofenced office employee — feed the rolling decision window every update.
    // Points too old for the live window (offline backlog syncing late) are NOT
    // live evidence — they go to the replay buffer, evaluated against their
    // historical capture times instead.
    const liveCutoff = Date.now() - GEOFENCE_WINDOW_MIN * 60_000;
    for (const p of points) {
      if (Number.isFinite(p.trackedAtMs) && p.trackedAtMs < liveCutoff) {
        recordReplayFix(userId, p.lat, p.lng, p.accuracy, p.trackedAtMs);
      } else {
        recordFix(userId, p.lat, p.lng, p.accuracy, p.trackedAtMs);
      }
    }

    // Must be currently punched in
    const date       = getISTDate();
    const attendance = await Attendance.findOne({ userId, date });
    if (!attendance?.punchIn?.time) return;

    // On lunch break — auto punch-out is suspended. This is the path that
    // fires most real-world auto punch-outs (continuous background location
    // updates), so this check is the one that actually matters for the
    // "never auto punch-out during lunch" guarantee.
    if (attendance.lunchIn?.time && !attendance.lunchOut?.time) return;

    const sessions       = attendance.sessions || [];
    const mainOpen       = !attendance.punchOut?.time;
    const additionalOpen = sessions.some(s => s.punchIn?.time && !s.punchOut?.time);
    if (!mainOpen && !additionalOpen) return;

    // Grace period: never auto punch-out this soon after a punch-in. The window
    // is cleared at punch-in, so this is belt-and-braces against any residual
    // pre-session evidence. Both timestamps are parsed from IST strings with the
    // same pattern, so the comparison is correct on any server timezone.
    const openSession     = sessions.find(s => s.punchIn?.time && !s.punchOut?.time);
    const openPunchInTime = openSession ? openSession.punchIn.time : attendance.punchIn.time;
    const punchInMs = new Date(`${date}T${openPunchInTime}`).getTime();
    const nowIstMs  = new Date(`${getISTDate()}T${getISTTime()}`).getTime();
    if (Number.isFinite(punchInMs) && Number.isFinite(nowIstMs) && nowIstMs - punchInMs < GEOFENCE_GRACE_MS) return;

    // Windowed-median decision: punch out only if the TYPICAL recent position is
    // clearly outside (radius + buffer). The median ignores isolated bad fixes —
    // even confidently-wrong ones — so a present employee is never punched out by
    // GPS noise. radius is stored in metres (the form converts km→m on save).
    const radiusM = typeof branch.radius === "number" ? branch.radius : 500;
    const verdict = medianOutside(userId, branch.latitude, branch.longitude, radiusM);

    // Live median didn't fire → consult the OFFLINE REPLAY buffer: a synced
    // backlog may prove the employee left while the device was offline. The
    // session then closes at the HISTORICAL exit time. Same-IST-day only —
    // yesterday's attendance doc isn't loaded here.
    let decision = null;
    let trigger  = "background";
    let closeMs  = null; // historical exit instant (ms); null = close at "now"
    if (verdict.decided && verdict.outside) {
      decision = verdict;
    } else {
      const exit = Number.isFinite(punchInMs)
        ? findHistoricalExit(userId, branch.latitude, branch.longitude, radiusM, punchInMs)
        : null;
      if (!exit) return; // no live or historical evidence → STAY PUNCHED IN
      if (istDateOf(exit.t) !== date) return; // overnight edge — admin corrects
      decision = exit;
      trigger  = "replay";
      closeMs  = exit.t;
    }

    // ── Trigger auto punch-out ─────────────────────────────────────────────
    clearFixes(userId);
    const mLat = decision.median.lat;
    const mLng = decision.median.lng;
    const timeString = closeMs ? istTimeOf(closeMs) : getISTTime();
    const reason     = "Employee automatically punched out after leaving the assigned branch geo-fence area.";

    attendance.autoPunchOut       = true;
    attendance.autoPunchOutReason = reason;
    attendance.geoFenceViolation  = true;
    attendance.geoStatus          = "outside_geofence";
    attendance.notes              = reason;
    attendance.calculatedDistance = Math.round(decision.dist);

    // Reverse-geocode the median exit location for admin visibility (best-effort;
    // provider chain — street-precise when a geocoding API key is configured)
    const exitAddress =
      (await reverseGeocode(mLat, mLng)) || `${mLat.toFixed(5)}, ${mLng.toFixed(5)}`;

    // Close open additional session first; otherwise close main session
    const openIdx = sessions.findIndex(s => s.punchIn?.time && !s.punchOut?.time);
    const closedSessionNumber = openIdx !== -1 ? sessions[openIdx].sessionNumber : 1;
    if (openIdx !== -1) {
      const sInMs  = new Date(`${date}T${sessions[openIdx].punchIn.time}`).getTime();
      const sOutMs = new Date(`${date}T${timeString}`).getTime();
      attendance.sessions[openIdx].punchOut     = { time: timeString, location: { lat: mLat, lng: mLng, address: exitAddress } };
      attendance.sessions[openIdx].durationMins = Math.max(0, Math.round((sOutMs - sInMs) / 60_000));
      attendance.sessions[openIdx].closeReason  = "auto_geofence";
    } else {
      attendance.punchOut = { time: timeString, location: { lat: mLat, lng: mLng, address: exitAddress } };
    }
    attendance.totalHours = _computeTotalHours(attendance);
    await finalizeAttendanceStatus(attendance, await _loadShiftForFinalize(attendance));

    await Promise.all([
      attendance.save(),
      User.findByIdAndUpdate(userId, { isTrackingActive: false }),
    ]);

    // Silent audit trail — written automatically, looked at only if disputed.
    GeofenceAudit.create({
      userId, date, time: timeString, branchId: branch._id, radiusM,
      medianLat: mLat, medianLng: mLng, distanceM: Math.round(decision.dist),
      windowMin: GEOFENCE_WINDOW_MIN, fixesInWindow: decision.n, trigger,
      fixes: decision.fixes,
    }).catch((e) => console.error("[GeoFence] audit write failed:", e.message));

    // Employee-facing event log (Today's Activity). `at` is the true event
    // instant — historical when this close came from offline replay.
    logAttendanceEvent({
      employeeId: userId,
      branchId: branch._id,
      date,
      type: "AUTO_PUNCH_OUT",
      source: "GEOFENCE",
      at: closeMs ? new Date(closeMs) : new Date(),
      time: timeString,
      sessionNumber: closedSessionNumber,
      lat: mLat,
      lng: mLng,
      accuracy: null,
      distanceFromBranch: Math.round(decision.dist),
    });

    // Notify the employee's device (app picks this up even on next open)
    if (io) {
      io.to(`user-${userId}`).emit("auto_punch_out", { reason });
    }

    console.log(`[GeoFence] Auto punch-out (${trigger}): userId=${userId}, medianDist=${Math.round(decision.dist)}m, radius=${radiusM}m, n=${decision.n}, at=${timeString}`);
  } catch (err) {
    console.error("[GeoFence] Background check failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Haversine distance in metres between two lat/lng pairs
// ---------------------------------------------------------------------------
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ---------------------------------------------------------------------------
// Merge RDP-simplified points back with Kalman-smoothed metadata.
//
// BUG FIX: simplify-js returns {x, y} pairs whose floating-point values are
// IDENTICAL to the input because it only *removes* points, it never modifies
// coordinates. So we can safely match by exact coordinate equality against
// the smoothed array (which DID modify coordinates). The correct source to
// simplify is the smoothed array, and we match back into the smoothed array
// by index, not by coordinate comparison.
//
// Strategy:
//   1. Build simplify-js input from smoothed[] (x=lng, y=lat)
//   2. Run simplify — it returns a subset of those exact {x,y} pairs
//   3. For each surviving {x,y}, find the index in smoothed[] where
//      smoothed[i].lng === x && smoothed[i].lat === y (exact match is safe
//      because simplify never alters values, only removes points)
//   4. Use that smoothed entry directly — coordinates already correct
// ---------------------------------------------------------------------------
const mergeSimplifiedWithMetadata = (smoothedPoints, simplifiedXY) => {
  // Build a fast lookup: "lng,lat" → index in smoothedPoints
  const coordKey = (lng, lat) => `${lng},${lat}`;
  const indexMap = new Map();
  smoothedPoints.forEach((p, i) => {
    indexMap.set(coordKey(p.lng, p.lat), i);
  });

  return simplifiedXY.map((sp) => {
    const key = coordKey(sp.x, sp.y);
    const idx = indexMap.get(key);
    if (idx !== undefined) {
      return smoothedPoints[idx]; // full metadata preserved
    }
    // Fallback: find nearest point by coordinate proximity (should be rare)
    let nearest = smoothedPoints[0];
    let minDist = Infinity;
    for (const p of smoothedPoints) {
      const d = Math.abs(p.lng - sp.x) + Math.abs(p.lat - sp.y);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    }
    return { ...nearest, lat: sp.y, lng: sp.x };
  });
};

// ---------------------------------------------------------------------------
// Build a clean polyline for DISPLAY from raw stored points. Applied ONCE at
// read time and never written back — so it cannot compound or erase real
// movement (doing this destructively on every write is the bug that previously
// collapsed routes). Recomputed from raw on each read, so it's always faithful.
// ---------------------------------------------------------------------------
const buildDisplayPath = (rawPath) => {
  if (!Array.isArray(rawPath) || rawPath.length < 5) return rawPath || [];
  const rawPoints = rawPath.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    timestamp: p.timestamp,
    speed: p.speed,
    batteryLevel: p.batteryLevel,
    visitId: p.visitId,
  }));
  const smoothed = smoothPath(rawPoints);
  const simplified = simplify(
    smoothed.map((p) => ({ x: p.lng, y: p.lat })),
    0.000009,
    true,
  );
  return mergeSimplifiedWithMetadata(smoothed, simplified);
};

// ---------------------------------------------------------------------------
// Throttled reverse-geocoding. Previously EVERY native point hit Nominatim,
// which would get the server rate-limited/blocked. Now we only geocode when the
// user has moved a meaningful distance (>150 m) or it's been >2 min since the
// last lookup for that user. Result patches User.lastKnownLocation.address.
// ---------------------------------------------------------------------------
const lastGeocode = new Map(); // userId -> { lat, lng, t }
function maybeReverseGeocode(userId, lat, lng) {
  const key = String(userId);
  const prev = lastGeocode.get(key);
  const now = Date.now();
  if (prev) {
    const moved = calculateDistance(prev.lat, prev.lng, lat, lng);
    if (moved < 150 && now - prev.t < 120_000) return; // too soon & barely moved
  }
  lastGeocode.set(key, { lat, lng, t: now });
  reverseGeocode(lat, lng)
    .then(async (address) => {
      if (address) {
        await User.findByIdAndUpdate(userId, {
          $set: { "lastKnownLocation.address": address },
        });
      }
    })
    .catch(() => {
      /* non-fatal */
    });
}

// ---------------------------------------------------------------------------
// Build a normalized path point from an incoming payload (single or batch).
// ---------------------------------------------------------------------------
function buildPathPoint(p) {
  const speed = Number(p.speed) || 0;
  return {
    lat: p.lat,
    lng: p.lng,
    timestamp: p.trackedAt ? new Date(p.trackedAt) : new Date(),
    speed,
    accuracy: Number(p.accuracy) || 0,
    batteryLevel: p.batteryLevel ?? null,
    activityType: p.activityType || (speed > 0.5 ? "moving" : "stationary"),
    visitId: p.visitId || null,
  };
}

// Path storage quality rules. Two failure modes observed on real routes:
//   1. PHANTOM TRAILS — coarse fixes (the 60s heartbeat bypasses the client's
//      ±50m accuracy filter) jump 100-300m while the phone sits still; a flat
//      80m movement threshold stored them and the smoother drew a walk that
//      never happened.
//   2. INVISIBLE REAL MOVEMENT — genuine walking in steps under 80m never
//      produced a stored point at all, so short real paths didn't render.
// Fix: never store a fix coarser than MAX_PATH_ACCURACY_M, and make the
// movement threshold ADAPTIVE — a fix only counts as movement once it moved
// further than max(MIN_MOVEMENT_M, 2× its own uncertainty). Good fixes (±5-15m)
// now register 30m steps; mediocre fixes must move far enough to be believed.
const MIN_MOVEMENT_M = 30;
const MAX_PATH_ACCURACY_M = 50;
const requiredMovementM = (accuracy) =>
  Math.max(MIN_MOVEMENT_M, (Number(accuracy) || 0) * 2);

// Append-only STORAGE decision (movement-based logging). Distance is NOT
// computed here — totalDistance is a derived, stop-aware value recomputed from
// the stored path on each write (see computeRouteDistance).
function planRouteAppend(route, incomingRaw) {
  const pushDocs = [];
  let lastStored = route.path.length ? route.path[route.path.length - 1] : null;
  for (const raw of incomingRaw) {
    const np = buildPathPoint(raw);
    if (np.accuracy > MAX_PATH_ACCURACY_M) continue; // junk never enters the path
    if (
      !lastStored ||
      calculateDistance(lastStored.lat, lastStored.lng, np.lat, np.lng) >
        requiredMovementM(np.accuracy)
    ) {
      pushDocs.push(np);
      lastStored = np;
    }
  }
  return { pushDocs, lastPoint: lastStored };
}

// ---------------------------------------------------------------------------
// POST /api/locations/tracking-token
// Issues a long-lived, tracking-scoped token the native background service uses
// for /locations/update. Caller must already be authenticated (normal login
// token) — this just upgrades that session to a token that survives a full
// shift even while the app is killed.
// ---------------------------------------------------------------------------
exports.issueTrackingToken = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id || req.user._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const token = jwt.sign(
      { userId, scope: "location_tracking" },
      process.env.JWT_SECRET,
      { expiresIn: TRACKING_TOKEN_TTL },
    );
    return res.status(200).json({ success: true, token, expiresIn: TRACKING_TOKEN_TTL });
  } catch (error) {
    console.error("[LocationController] issueTrackingToken error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// POST /api/locations/update
// ---------------------------------------------------------------------------
exports.updateLocation = async (req, res) => {
  try {
    const {
      lat,
      lng,
      address,
      batteryLevel,
      activityType,
      visitId,
      trackedAt,
      speed,
      accuracy,
      sessionId,
    } = req.body;

    const userId = req.user.userId || req.user.id || req.user._id;
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: User ID not found" });
    }
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({
        success: false,
        message: "Coordinates (lat, lng) are required",
      });
    }
    const badCoordinate =
      checkNumber("Latitude", lat, { min: -90, max: 90 }) || checkNumber("Longitude", lng, { min: -180, max: 180 });
    if (badCoordinate || typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ success: false, message: badCoordinate || "Coordinates must be numbers" });
    }

    // Use whatever address the client sent; kick off reverse-geocoding in the
    // background and patch the DB + socket once it resolves — never block the response.
    let finalAddress =
      address && address !== "Browser Location Update"
        ? address
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    const locationData = {
      type: "Point",
      coordinates: [lng, lat],
      address: finalAddress,
    };

    // Throttled reverse-geocoding (only on meaningful movement) — see helper.
    const needsGeocode = !address || address === "Browser Location Update";
    if (needsGeocode) maybeReverseGeocode(userId, lat, lng);

    // --- Respond immediately — all DB writes are fire-and-forget ---
    res.status(201).json({ success: true, data: { location: locationData } });

    // --- Emit socket (non-blocking, post-response) ---
    const io = req.app.get("io");
    if (io) {
      User.findById(userId)
        .select("name employeeCode avatar role")
        .populate("role", "label")
        .then((userDoc) => {
          io.emit("location_update", {
            userId,
            employee: userDoc,
            lat,
            lng,
            address: finalAddress,
            trackedAt: new Date(),
            batteryLevel,
            speed,
            accuracy,
            isPingResponse: req.body.isPingResponse,
          });
        })
        .catch(() => {
          io.emit("location_update", {
            userId,
            lat,
            lng,
            address: finalAddress,
            trackedAt: new Date(),
            batteryLevel,
            speed,
            accuracy,
          });
        });
    }

    // --- Update user's lastKnownLocation (non-blocking) ---
    User.findByIdAndUpdate(userId, {
      $set: { lastKnownLocation: { ...locationData, updatedAt: new Date() } },
    }).catch((err) =>
      console.error(
        "[LocationController] lastKnownLocation update error:",
        err.message,
      ),
    );

    // --- Route / session management (fully non-blocking, post-response) ---
    (async () => {
      try {
        const dateStr = new Date().toISOString().split("T")[0];

        let route;
        try {
          route = await EmployeeRoute.findOneAndUpdate(
            { employeeId: userId, date: dateStr },
            {
              $setOnInsert: {
                sessionId: `day_session_${userId}_${dateStr}`,
                startAddress: finalAddress,
                startTime: new Date(),
              },
            },
            {
              upsert: true,
              returnDocument: "after",
              setDefaultsOnInsert: true,
            },
          );
        } catch (upsertErr) {
          if (upsertErr.code === 11000) {
            route = await EmployeeRoute.findOne({
              employeeId: userId,
              date: dateStr,
            });
          } else {
            throw upsertErr;
          }
        }
        if (!route) return;

        // Append-only (raw points are never overwritten/smoothed here). Smoothing
        // and stop detection are read-time, non-destructive transforms.
        const { pushDocs } = planRouteAppend(route, [
          { lat, lng, trackedAt, speed, accuracy, batteryLevel, visitId, activityType },
        ]);
        if (pushDocs.length) {
          // Recompute the stop-aware total from the full raw path (self-heals
          // historical inflation on the next write; never mutates path[]).
          const fullPath = (route.path || []).concat(pushDocs);
          await EmployeeRoute.findByIdAndUpdate(route._id, {
            $push: { path: { $each: pushDocs } },
            $set: {
              totalDistance: computeRouteDistance(fullPath),
              endAddress: finalAddress,
              endTime: new Date(),
            },
          });
        }
      } catch (routeError) {
        console.error(
          "[LocationController] Route session error (non-fatal):",
          routeError.message,
        );
      }
    })();

    // ── Background geofence check (non-blocking, post-response) ────────────
    // Works whether the app is open or closed — the native BackgroundGeolocation
    // plugin sends location updates even when the app is minimized / killed.
    _checkGeofenceAndAutoPunchOut(
      userId.toString(),
      [{ lat, lng, accuracy, trackedAtMs: trackedAt ? new Date(trackedAt).getTime() : undefined }],
      req.app.get("io"),
    );

  } catch (error) {
    console.error("[LocationController] updateLocation error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// POST /api/locations/update/batch
// Accepts { points: [ {lat,lng,accuracy,speed,batteryLevel,activityType,
// sessionId,trackedAt}, ... ] }. One request for many queued points (native
// background sync) — far fewer HTTP calls / less battery than one-per-point.
// Persists BEFORE responding, so the client only clears its local queue on a
// confirmed 2xx.
// ---------------------------------------------------------------------------
exports.batchUpdate = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id || req.user._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const points = Array.isArray(req.body?.points) ? req.body.points : null;
    if (!points || points.length === 0) {
      return res.status(400).json({ success: false, message: "points[] is required" });
    }

    // Keep only valid points; process in chronological order.
    const valid = points
      .filter((p) => p && isValidPoint(p))
      .sort((a, b) => new Date(a.trackedAt || 0) - new Date(b.trackedAt || 0));
    if (valid.length === 0) {
      return res.status(400).json({ success: false, message: "No valid points" });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    let route;
    try {
      route = await EmployeeRoute.findOneAndUpdate(
        { employeeId: userId, date: dateStr },
        {
          $setOnInsert: {
            sessionId: `day_session_${userId}_${dateStr}`,
            startTime: new Date(),
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (e) {
      if (e.code === 11000) {
        route = await EmployeeRoute.findOne({ employeeId: userId, date: dateStr });
      } else {
        throw e;
      }
    }
    if (!route) {
      return res.status(500).json({ success: false, message: "Route unavailable" });
    }

    const { pushDocs, lastPoint } = planRouteAppend(route, valid);
    const finalAddress = lastPoint
      ? `${lastPoint.lat.toFixed(5)}, ${lastPoint.lng.toFixed(5)}`
      : route.endAddress;

    if (pushDocs.length) {
      const fullPath = (route.path || []).concat(pushDocs);
      await EmployeeRoute.findByIdAndUpdate(route._id, {
        $push: { path: { $each: pushDocs } },
        $set: {
          totalDistance: computeRouteDistance(fullPath),
          endAddress: finalAddress,
          endTime: new Date(),
        },
      });
    }

    // Persisted — safe for the client to delete its local queue now.
    res.status(201).json({ success: true, accepted: valid.length, stored: pushDocs.length });

    // ---- Post-response side effects, on the LATEST point only ----
    const newest = valid[valid.length - 1];
    const lat = newest.lat;
    const lng = newest.lng;
    const locationData = { type: "Point", coordinates: [lng, lat], address: finalAddress };

    User.findByIdAndUpdate(userId, {
      $set: { lastKnownLocation: { ...locationData, updatedAt: new Date() } },
    }).catch(() => {});

    maybeReverseGeocode(userId, lat, lng);

    const io = req.app.get("io");
    if (io) {
      User.findById(userId)
        .select("name employeeCode avatar role")
        .populate("role", "label")
        .then((userDoc) => {
          io.emit("location_update", {
            userId,
            employee: userDoc,
            lat,
            lng,
            address: finalAddress,
            trackedAt: newest.trackedAt ? new Date(newest.trackedAt) : new Date(),
            batteryLevel: newest.batteryLevel,
            speed: newest.speed,
            accuracy: newest.accuracy,
          });
        })
        .catch(() => {
          io.emit("location_update", {
            userId, lat, lng, address: finalAddress, trackedAt: new Date(),
          });
        });
    }

    // Feed EVERY batch point into the decision window with its own capture time
    // (recordFix prunes anything already older than the window), then evaluate.
    _checkGeofenceAndAutoPunchOut(
      userId.toString(),
      valid.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy,
        trackedAtMs: p.trackedAt ? new Date(p.trackedAt).getTime() : undefined,
      })),
      io,
    );
  } catch (error) {
    console.error("[LocationController] batchUpdate error:", error);
    if (!res.headersSent) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/reverse-geocode?lat=..&lng=..
// Address lookup for the admin UI (attendance detail dialogs). Runs through
// the server-side provider chain so API keys never reach the browser, and
// old records display street-precise addresses once a key is configured.
// Cached in-memory per rounded coordinate — dialogs re-open often.
// ---------------------------------------------------------------------------
const geocodeCache = new Map(); // "lat,lng" (5dp) -> { address, t }
const GEOCODE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
exports.reverseGeocodeAddress = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ success: false, message: "lat and lng are required" });
    }
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = geocodeCache.get(key);
    if (hit && Date.now() - hit.t < GEOCODE_CACHE_TTL_MS) {
      return res.status(200).json({ success: true, address: hit.address, cached: true });
    }
    const address = await reverseGeocode(lat, lng);
    if (address) geocodeCache.set(key, { address, t: Date.now() });
    return res.status(200).json({ success: true, address });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/latest  — fast dashboard render
// ---------------------------------------------------------------------------
exports.getLatestLocations = async (req, res) => {
  try {
    const { storeId } = req.query;
    // Include ALL active staff, not just those with a recorded location,
    // so staff who haven't reported GPS yet still appear (as offline).
    const userQuery = {
      isActive: true,
      tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null),
    };
    if (storeId) userQuery.storeId = storeId;

    const employees = await User.find(userQuery)
      .select("name employeeCode role avatar mobile lastKnownLocation")
      .populate("role", "label");

    const todayStr = new Date().toISOString().split("T")[0];
    const routes = await EmployeeRoute.find({ date: todayStr });
    const routeMap = new Map();
    routes.forEach((r) =>
      routeMap.set(r.employeeId.toString(), r.totalDistance),
    );

    const results = employees.map((emp) => ({
      _id: emp._id,
      userId: emp._id,
      employeeId: emp._id,
      employee: {
        _id: emp._id,
        name: emp.name,
        employeeCode: emp.employeeCode,
        avatar: emp.avatar,
        role: emp.role,
        mobile: emp.mobile,
      },
      location: {
        lat: emp.lastKnownLocation?.coordinates?.[1] || 0,
        lng: emp.lastKnownLocation?.coordinates?.[0] || 0,
        address: emp.lastKnownLocation?.address || "Unknown Location",
      },
      trackedAt: emp.lastKnownLocation?.updatedAt || null,
      totalDistance: routeMap.get(emp._id.toString()) || 0,
      // Provide compatibility with older frontend fields if any
      lat: emp.lastKnownLocation?.coordinates?.[1] || 0,
      lng: emp.lastKnownLocation?.coordinates?.[0] || 0,
    }));

    return res.status(200).json({ success: true, data: results });
  } catch (error) {
    console.error("[LocationController] getLatestLocations error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/path  — full day path for dashboard polyline
// ---------------------------------------------------------------------------
exports.getEmployeePath = async (req, res) => {
  try {
    const { employeeId, date } = req.query;
    if (!employeeId) {
      return res
        .status(400)
        .json({ success: false, message: "employeeId is required" });
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const ownedEmployee = await User.findOne({ _id: employeeId, ...tenantFilter }).select("_id");
    if (!ownedEmployee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const dateStr = date || new Date().toISOString().split("T")[0];
    const routes = await EmployeeRoute.find({ employeeId, date: dateStr }).sort(
      { startTime: 1 },
    );

    // Concatenate all path segments for the day. Smoothing/simplification is
    // applied here (read time) from the raw stored points — never on write.
    const fullPath = routes.reduce((acc, route) => {
      const points = buildDisplayPath(route.path).map((p) => ({
        lat: p.lat,
        lng: p.lng,
        timestamp: p.timestamp,
        speed: p.speed,
        accuracy: p.accuracy,
        batteryLevel: p.batteryLevel,
        visitId: p.visitId,
        address: route.endAddress,
      }));
      return acc.concat(points);
    }, []);

    // Stops derived from the RAW concatenated path (dwell clusters survive),
    // read-time and non-destructive. Display polyline still uses fullPath.
    const rawPath = routes.reduce((acc, r) => acc.concat(r.path || []), []);
    const stops = detectStops(rawPath);
    // Polyline source: raw travel points + one collapsed node per dwell.
    const displayPath = buildReducedPath(rawPath);

    return res.status(200).json({ success: true, data: fullPath, stops, displayPath });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/routes  — list of route sessions (no path data)
// ---------------------------------------------------------------------------
exports.getEmployeeRoutes = async (req, res) => {
  try {
    const { employeeId, date } = req.query;

    if (employeeId) {
      const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
      const ownedEmployee = await User.findOne({ _id: employeeId, ...tenantFilter }).select("_id");
      if (!ownedEmployee) {
        return res.status(404).json({ success: false, message: "Employee not found" });
      }
    }

    const query = { employeeId: employeeId || req.user.userId };
    if (date) query.date = date;

    const routes = await EmployeeRoute.find(query)
      .select("-path")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, data: routes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/routes/:routeId  — single route with full path
// ---------------------------------------------------------------------------
exports.getRouteDetails = async (req, res) => {
  try {
    const route = await EmployeeRoute.findById(req.params.routeId);
    if (!route)
      return res
        .status(404)
        .json({ success: false, message: "Route not found" });

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const ownedEmployee = await User.findOne({ _id: route.employeeId, ...tenantFilter }).select("_id");
    if (!ownedEmployee) {
      return res.status(404).json({ success: false, message: "Route not found" });
    }
    // Return a display-smoothed copy without mutating stored raw history,
    // plus derived stops/visits.
    const data = route.toObject();
    data.totalDistance = computeRouteDistance(route.path); // stop-aware, from raw
    data.stops = detectStops(route.path);     // raw → faithful dwell detection
    data.displayPath = buildReducedPath(route.path); // polyline: raw travel + collapsed dwells
    data.path = buildDisplayPath(data.path);  // kept for any legacy consumer
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/locations/geofence-audit — admin view of the silent auto-punch-out
// trail (see geofence_audit_model.js). Read-only; nothing here is written by
// this endpoint, it only surfaces what _checkGeofenceAndAutoPunchOut /
// attendance_controller.js's autoPunchOut already record.
// ---------------------------------------------------------------------------
exports.getGeofenceAuditLogs = async (req, res) => {
  try {
    const { userId, branchId, startDate, endDate, page, limit } = req.query;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    // Scope to the requester's own tenant via its employees — GeofenceAudit
    // itself has no tenant_id (it's keyed by userId only), same pattern as
    // getLatestLocations/getEmployeePath above.
    const tenantUserIds = await User.find(tenantFilter).select("_id").lean();
    const query = { userId: { $in: tenantUserIds.map((u) => u._id) } };

    if (userId) query.userId = userId;
    if (branchId) query.branchId = branchId;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    const [total, rows] = await Promise.all([
      GeofenceAudit.countDocuments(query),
      GeofenceAudit.find(query)
        .select("-fixes") // raw fix array is only needed for a dispute deep-dive, not the list view
        .populate("userId", "name email")
        .populate("branchId", "name")
        .sort({ date: -1, time: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    return res.status(200).json({
      success: true,
      data: rows,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
