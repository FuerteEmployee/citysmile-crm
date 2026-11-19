// ---------------------------------------------------------------------------
// Windowed-median geofence decision.
//
// Auto-punch-out must never fire on a single bad GPS fix. This hardware reports
// confidently-wrong positions (good accuracy, kilometres off the truth), so an
// accuracy gate or a "2 readings in a row" rule can't be trusted. Instead we keep
// a trailing T-minute window of recent fixes per user and look at the MEDIAN
// position — the median of a jitter/noise cloud sits at the TRUE location, so
// isolated bad fixes (even confident ones) can't move it. We only punch out when
// the median is clearly outside the branch, i.e. the person has genuinely and
// persistently left.
//
// In-memory by design (like the old consecutive counter). A server restart just
// means a few minutes where we ABSTAIN — and abstaining means STAY PUNCHED IN.
// Bias is always conservative: when unsure, keep the employee punched in.
// ---------------------------------------------------------------------------
const GEOFENCE_WINDOW_MIN     = 10;   // T — retention window for fixes (audit + freshness cap)
const GEOFENCE_MIN_ACCURACY_M = 100;  // drop worse fixes from the window (cheap extra guard)
// All decision knobs are env-overridable so responsiveness can be tuned on the
// server without a code change.
const GEOFENCE_MIN_FIXES      = Number(process.env.GEOFENCE_MIN_FIXES) || 5;    // decide on this many most-recent fixes
const GEOFENCE_MIN_SPAN_MS    = Number(process.env.GEOFENCE_MIN_SPAN_MS) || 90_000; // deciding fixes must span ≥ this (outlasts noise bursts)
const GEOFENCE_GRACE_MS       = Number(process.env.GEOFENCE_GRACE_MS) || 60_000;    // no auto punch-out this soon after a punch-in

// No buffer — auto punch-out fires at the exact configured radius, matching
// the punch-in geofence check (attendance_controller.js), which also has no
// buffer. Previously this added +20-50m so GPS jitter near the boundary
// couldn't flap a stationary employee's session; removing it trades that
// safety margin for an exact-radius trigger, per explicit request.
function exitBufferM(radiusM) {
  return 0;
}

const buffers = new Map(); // userId(string) -> [{ t, lat, lng, acc }]

// Historical points for OFFLINE REPLAY: fixes that arrive too old for the
// live window (device was offline, queue synced late). The live path must
// ignore them (stale-evidence bug), but they are legitimate evidence of what
// happened WHILE offline — findHistoricalExit() walks them in capture order
// to close a session at the historical exit time. Separate buffer by design:
// the 10-min freshness filter applies ONLY to the live path.
const replayBuffers = new Map(); // userId(string) -> [{ t, lat, lng, acc }]
const REPLAY_MAX_POINTS = 600;
const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Append a fix to the user's trailing window and prune anything older than T.
// trackedAtMs (optional) is when the CLIENT captured the fix. Offline queues
// flush old points long after capture — stamping those with receive time made
// stale positions look live and let them dominate the median. A capture time
// in the past is honoured (and pruned if beyond the window); a missing or
// future timestamp falls back to receive time.
function recordFix(userId, lat, lng, accuracy, trackedAtMs) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) return;
  const now = Date.now();
  const t =
    Number.isFinite(trackedAtMs) && trackedAtMs > 0 && trackedAtMs <= now
      ? trackedAtMs
      : now;
  const cutoff = now - GEOFENCE_WINDOW_MIN * 60_000;
  if (t < cutoff) return; // already older than the window — never evidence
  const key = String(userId);
  const arr = buffers.get(key) || [];
  arr.push({ t, lat, lng, acc: Number(accuracy) || 0 });
  arr.sort((a, b) => a.t - b.t); // out-of-order flushes arrive; keep window chronological
  while (arr.length && arr[0].t < cutoff) arr.shift();
  buffers.set(key, arr);
}

function clearFixes(userId) {
  buffers.delete(String(userId));
  replayBuffers.delete(String(userId));
}

// Record a fix that arrived too old for the live window (offline backlog).
// Capture time is trusted as-is here — that is the whole point of replay.
// Duplicates (a retried sync re-delivering the same points) are dropped so a
// partial-failure retry can never shift the computed exit time.
function recordReplayFix(userId, lat, lng, accuracy, trackedAtMs) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) return;
  if (!Number.isFinite(trackedAtMs) || trackedAtMs <= 0) return; // no capture time → not replayable
  const now = Date.now();
  if (trackedAtMs > now || now - trackedAtMs > REPLAY_MAX_AGE_MS) return;
  const key = String(userId);
  const arr = replayBuffers.get(key) || [];
  if (arr.some((f) => f.t === trackedAtMs && f.lat === lat && f.lng === lng)) return;
  arr.push({ t: trackedAtMs, lat, lng, acc: Number(accuracy) || 0 });
  arr.sort((a, b) => a.t - b.t);
  while (arr.length > REPLAY_MAX_POINTS) arr.shift();
  replayBuffers.set(key, arr);
}

// Walk the replay buffer in capture order and find the FIRST moment the
// median of GEOFENCE_MIN_FIXES consecutive good fixes (spanning >= the same
// GEOFENCE_MIN_SPAN_MS as the live path) sat clearly outside the fence.
// Only fixes captured after sessionStartMs + grace count — same fencing as
// clearFixes gives the live path. Returns { t, dist, median, n, fixes } for
// the historical exit, or null. Idempotency lives with the CALLER: it must
// only act when a session is still open.
function findHistoricalExit(userId, centerLat, centerLng, radiusM, sessionStartMs) {
  const all = replayBuffers.get(String(userId)) || [];
  const eligible = all.filter(
    (f) =>
      f.t >= sessionStartMs + GEOFENCE_GRACE_MS &&
      (!f.acc || f.acc <= GEOFENCE_MIN_ACCURACY_M),
  );
  if (eligible.length < GEOFENCE_MIN_FIXES) return null;
  for (let i = GEOFENCE_MIN_FIXES - 1; i < eligible.length; i++) {
    const win = eligible.slice(i - GEOFENCE_MIN_FIXES + 1, i + 1);
    if (win[win.length - 1].t - win[0].t < GEOFENCE_MIN_SPAN_MS) continue;
    const mLat = median(win.map((f) => f.lat));
    const mLng = median(win.map((f) => f.lng));
    const dist = haversine(mLat, mLng, centerLat, centerLng);
    if (dist > radiusM + exitBufferM(radiusM)) {
      return {
        t: win[win.length - 1].t,
        dist,
        median: { lat: mLat, lng: mLng },
        n: win.length,
        fixes: win.map((f) => ({ lat: f.lat, lng: f.lng, acc: f.acc, t: new Date(f.t) })),
      };
    }
  }
  return null;
}

// Decide whether the MEDIAN of the most recent fixes is clearly outside the
// geofence. Returns { decided, outside, dist, median:{lat,lng}, n, fixes }.
// decided=false means not enough trustworthy evidence yet — caller must STAY
// PUNCHED IN. fixes is the exact set the decision used, for the audit trail.
//
// Decision = median of the LAST GEOFENCE_MIN_FIXES good fixes, provided they
// span ≥ GEOFENCE_MIN_SPAN_MS. Deciding on the newest fixes (instead of the
// whole 10-min window) means old inside-positions stop dragging the median
// back the moment enough fresh evidence exists — an employee who walks out is
// punched out ~2 min after leaving, not ~5. The span floor keeps a short
// noise burst (measured ≤1 min of confidently-wrong fixes) from supplying a
// majority of the deciding fixes.
function medianOutside(userId, centerLat, centerLng, radiusM) {
  const now = Date.now();
  const good = (buffers.get(String(userId)) || []).filter(
    (f) =>
      now - f.t <= GEOFENCE_WINDOW_MIN * 60_000 &&
      (!f.acc || f.acc <= GEOFENCE_MIN_ACCURACY_M),
  );
  if (good.length < GEOFENCE_MIN_FIXES) return { decided: false, n: good.length };
  const arr = good.slice(-GEOFENCE_MIN_FIXES);
  if (arr[arr.length - 1].t - arr[0].t < GEOFENCE_MIN_SPAN_MS) {
    return { decided: false, n: good.length };
  }
  const mLat = median(arr.map((f) => f.lat));
  const mLng = median(arr.map((f) => f.lng));
  const dist = haversine(mLat, mLng, centerLat, centerLng);
  return {
    decided: true,
    outside: dist > radiusM + exitBufferM(radiusM),
    dist,
    median: { lat: mLat, lng: mLng },
    n: arr.length,
    fixes: arr.map((f) => ({ lat: f.lat, lng: f.lng, acc: f.acc, t: new Date(f.t) })),
  };
}

module.exports = {
  recordFix,
  recordReplayFix,
  findHistoricalExit,
  clearFixes,
  medianOutside,
  exitBufferM,
  GEOFENCE_WINDOW_MIN,
  GEOFENCE_MIN_ACCURACY_M,
  GEOFENCE_MIN_FIXES,
  GEOFENCE_MIN_SPAN_MS,
  GEOFENCE_GRACE_MS,
};
