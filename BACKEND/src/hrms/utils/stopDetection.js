// ---------------------------------------------------------------------------
// Route metrics derived from a RAW GPS path (never stored): stop/visit
// detection and a stop-aware total distance. Both are read/derive-time, so the
// stored path[] stays the immutable source of truth and no migration is needed.
//
// A "stop" is a run of consecutive points that stay within `radiusM` of the
// run's anchor for >= `minDwellMin`; adjacent runs whose representative points
// are within `mergeM` are merged (heals dwells that jitter fragments into many
// short stops on low-quality hardware). Representative coordinate is the MEDIAN
// of the cluster (robust to the outlier fixes a mean would drag).
//
// Distance is computed by collapsing each dwell to a single representative
// point and summing the reduced sequence — so parked jitter contributes ~0 km
// while real travel legs are preserved, regardless of per-fix accuracy.
// ---------------------------------------------------------------------------
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

const DEFAULTS = { radiusM: 50, minDwellMin: 5, mergeM: 75 };
const MIN_SEGMENT_M = 20;       // GPS noise floor for the reduced-sequence distance
const MAX_SPEED_MPS = 35;       // ~126 km/h — faster than this is a teleport/bad fix
const MAX_SEGMENT_M = 25_000;   // 25 km — a single hop between consecutive fixes
                                // longer than this isn't trustworthy continuous
                                // travel (real movement logs ~1000 pts/day, so legs
                                // are densely sampled); it's a glitch fix across a
                                // tracking gap. Well above any real leg (~7 km),
                                // well below observed glitch hops (42–471 km).
// Hysteresis for LEAVING a dwell: a lone out-of-radius fix (GPS jitter, even a
// wild >50 m spike) must NOT end the stop. Only this many CONSECUTIVE
// out-of-radius fixes count as a real departure; isolated strays are absorbed
// into the dwell, consolidating a desk session into one stop.
const EXIT_CONSECUTIVE_PTS = 3;

// Maximal dwell runs as [startIdx, endIdx), with adjacent same-location runs merged.
function _stopRuns(path, radiusM, minDwellMin, mergeM) {
  const runs = [];
  let i = 0;
  while (i < path.length) { 
    // Anchor the candidate dwell at path[i] and scan forward. Hysteresis: absorb
    // lone stray fixes; only EXIT_CONSECUTIVE_PTS out-of-radius IN A ROW ends it.
    let j = i + 1;
    let lastIn = i;   // last index still inside the cluster (radius of anchor)
    let outRun = 0;   // consecutive out-of-radius fixes since the last in-radius one
    while (j < path.length) {
      if (haversine(path[i].lat, path[i].lng, path[j].lat, path[j].lng) <= radiusM) {
        lastIn = j;
        outRun = 0;
      } else if (++outRun >= EXIT_CONSECUTIVE_PTS) {
        break; // sustained departure — real exit
      }
      j += 1;
    }
    const e = lastIn + 1; // dwell = [i, e); the exiting stray run stays out of it
    const dwellMin =
      (new Date(path[e - 1].timestamp).getTime() - new Date(path[i].timestamp).getTime()) / 60_000;
    if (e - i >= 2 && dwellMin >= minDwellMin) {
      runs.push([i, e]);
      i = e; // skip the entire dwell
    } else {
      i += 1;
    }
  }
  // Merge adjacent runs whose median representatives are within mergeM.
  const merged = [];
  for (const [s, e] of runs) {
    const last = merged[merged.length - 1];
    if (last) {
      const a = path.slice(last[0], last[1]);
      const b = path.slice(s, e);
      const d = haversine(
        median(a.map((p) => p.lat)), median(a.map((p) => p.lng)),
        median(b.map((p) => p.lat)), median(b.map((p) => p.lng)),
      );
      if (d <= mergeM) { last[1] = e; continue; }
    }
    merged.push([s, e]);
  }
  return merged;
}

function detectStops(path, opts = {}) {
  if (!Array.isArray(path) || path.length < 2) return [];
  const { radiusM, minDwellMin, mergeM } = { ...DEFAULTS, ...opts };
  return _stopRuns(path, radiusM, minDwellMin, mergeM).map(([s, e]) => {
    const c = path.slice(s, e);
    const startT = new Date(path[s].timestamp).getTime();
    const endT = new Date(path[e - 1].timestamp).getTime();
    return {
      lat: median(c.map((p) => p.lat)),
      lng: median(c.map((p) => p.lng)),
      arrivalTime: new Date(startT),
      departureTime: new Date(endT),
      durationMinutes: Math.round((endT - startT) / 60_000),
      points: e - s,
    };
  });
}

// Stop-aware total distance in METRES. Collapse each dwell to one representative
// point, then sum the reduced sequence with a teleport gate + small noise floor.
function computeRouteDistance(path, opts = {}) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  const { radiusM, minDwellMin, mergeM } = { ...DEFAULTS, ...opts };
  const runs = _stopRuns(path, radiusM, minDwellMin, mergeM);

  // Reduced sequence: each element carries an arrival (tIn) and departure (tOut)
  // time. A moving fix has tIn === tOut; a collapsed dwell spans arrival→
  // departure, so the dwell's own duration never looks like a tracking gap.
  const reduced = [];
  let i = 0;
  for (const [s, e] of runs) {
    while (i < s) {
      const t = new Date(path[i].timestamp).getTime();
      reduced.push({ lat: path[i].lat, lng: path[i].lng, accuracy: path[i].accuracy || 0, tIn: t, tOut: t });
      i++;
    }
    const c = path.slice(s, e);
    reduced.push({
      lat: median(c.map((p) => p.lat)),
      lng: median(c.map((p) => p.lng)),
      accuracy: 0,
      tIn: new Date(path[s].timestamp).getTime(),
      tOut: new Date(path[e - 1].timestamp).getTime(),
    });
    i = e;
  }
  while (i < path.length) {
    const t = new Date(path[i].timestamp).getTime();
    reduced.push({ lat: path[i].lat, lng: path[i].lng, accuracy: path[i].accuracy || 0, tIn: t, tOut: t });
    i++;
  }

  let metres = 0;
  let last = null;
  for (const p of reduced) {
    if (!last) { last = p; continue; }
    const seg = haversine(last.lat, last.lng, p.lat, p.lng);
    const dt = Math.max(1, (p.tIn - last.tOut) / 1000);
    // Untrustworthy jumps (glitch fix / teleport) — reject WITHOUT advancing, so
    // the next segment is measured from the last trustworthy point rather than
    // anchoring to the bad fix.
    if (seg > MAX_SEGMENT_M || seg / dt > MAX_SPEED_MPS) continue;
    const floor = Math.max(p.accuracy || 0, last.accuracy || 0, MIN_SEGMENT_M);
    if (seg >= floor) metres += seg;
    last = p;
  }
  return Math.round(metres);
}

// Reduced DISPLAY path: moving fixes kept byte-for-byte (raw), each detected
// dwell collapsed to ONE node at the stop's median lat/lng (so the polyline and
// the stop marker coincide). Travel segments are therefore identical to raw;
// only stationary clusters collapse — killing the seated "spider web" and the
// stray spikes. Derived/read-time; never mutates path[].
function buildReducedPath(path, opts = {}) {
  if (!Array.isArray(path) || path.length < 2) return Array.isArray(path) ? path.slice() : [];
  const { radiusM, minDwellMin, mergeM } = { ...DEFAULTS, ...opts };
  const runs = _stopRuns(path, radiusM, minDwellMin, mergeM);
  const out = [];
  let i = 0;
  for (const [s, e] of runs) {
    while (i < s) out.push(path[i++]);     // moving fixes — raw, untouched
    const c = path.slice(s, e);
    out.push({                              // dwell → single node at the stop median
      lat: median(c.map((p) => p.lat)),
      lng: median(c.map((p) => p.lng)),
      timestamp: path[s].timestamp,
      isStop: true,
    });
    i = e;
  }
  while (i < path.length) out.push(path[i++]);
  return out;
}

module.exports = { detectStops, computeRouteDistance, buildReducedPath };
