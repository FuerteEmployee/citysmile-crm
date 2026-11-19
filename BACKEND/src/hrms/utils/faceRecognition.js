// Face matching for HRMS Face Attendance (kiosk + selfie check).
//
// The Python face service (CRM-BACKEND/face-service, ported from BOTLens) turns
// an image into faces + 128-number SFace embeddings. Everything else lives
// here: comparing embeddings against the enrolled FaceProfiles, per tenant.

const http = require("http");
const axios = require("axios");
const FaceProfile = require("../models/face_profile_model");

const FACE_SERVICE_URL = (process.env.FACE_SERVICE_URL || "http://127.0.0.1:8100").replace(/\/$/, "");
const FACE_SERVICE_KEY = process.env.FACE_SERVICE_KEY || "";
// SFace cosine similarity. OpenCV's reference threshold is 0.363; BOTLens ran
// at 0.42 and that is kept as the default (fewer false matches at a kiosk).
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.42;

class FaceServiceUnavailable extends Error {}

// No keep-alive: uvicorn drops idle connections after 5s, and Node reusing one
// at that moment fails the request with ECONNRESET. A fresh local connection
// per call costs next to nothing.
const httpAgent = new http.Agent({ keepAlive: false });

/**
 * @param {Buffer[]} buffers JPEG/PNG images
 * @returns {Promise<Array<{error?: string, width: number, height: number,
 *   faces: Array<{box: number[], score: number, pose: {yaw: string, pitch: string}, embedding: number[]}>}>>}
 *   one result per image, faces largest first
 */
async function embedImages(buffers, { maxFaces = 5 } = {}) {
  const body = { images: buffers.map((b) => b.toString("base64")), max_faces: maxFaces };
  const options = {
    headers: FACE_SERVICE_KEY ? { "x-face-service-key": FACE_SERVICE_KEY } : {},
    timeout: 20000,
    maxBodyLength: Infinity,
    httpAgent,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const { data } = await axios.post(`${FACE_SERVICE_URL}/embed`, body, options);
      return data.results;
    } catch (err) {
      if (err.response && err.response.status < 500) {
        throw new Error(err.response.data?.detail || "The face service rejected the image");
      }
      if (attempt === 1 && ["ECONNRESET", "EPIPE"].includes(err.code)) continue;
      console.warn(`[face] ${FACE_SERVICE_URL}/embed failed:`, err.code || err.response?.status || err.message);
      throw new FaceServiceUnavailable("Face recognition service is not reachable");
    }
  }
}

async function isServiceUp() {
  try {
    await axios.get(`${FACE_SERVICE_URL}/health`, { timeout: 3000, httpAgent });
    return true;
  } catch {
    return false;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Highest similarity between one face and any of a profile's enrolment photos.
const profileScore = (embedding, profile) =>
  Math.max(...profile.embeddings.map((e) => cosine(embedding, e)));

// ── Per-tenant cache of enrolled faces (the kiosk asks ~1x/second) ──────────
const CACHE_MS = 60 * 1000;
const cache = new Map();
const tenantKey = (tenantId) => String(tenantId || "none");

async function tenantProfiles(tenantId) {
  const key = tenantKey(tenantId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.profiles;
  const profiles = await FaceProfile.find({ tenant_id: tenantId || null }).select("userId embeddings").lean();
  cache.set(key, { at: Date.now(), profiles });
  return profiles;
}

const invalidateTenant = (tenantId) => cache.delete(tenantKey(tenantId));

/**
 * Best-matching enrolled employee for one face, or null below the threshold.
 * allowedIds (Set of id strings) narrows the candidates, e.g. a supervisor's branches.
 */
function matchFace(embedding, profiles, allowedIds = null, excludeUserId = null) {
  let best = null;
  for (const p of profiles) {
    const id = String(p.userId);
    if ((allowedIds && !allowedIds.has(id)) || id === String(excludeUserId)) continue;
    const score = profileScore(embedding, p);
    if (!best || score > best.score) best = { userId: id, score };
  }
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}

/**
 * Face check for an employee's own selfie punch. Never throws.
 * status: not_enrolled | verified | mismatch | no_face | unavailable
 */
async function verifySelfie(userId, buffer) {
  const profile = await FaceProfile.findOne({ userId }).select("embeddings").lean();
  if (!profile) return { status: "not_enrolled" };
  let result;
  try {
    [result] = await embedImages([buffer], { maxFaces: 3 });
  } catch {
    return { status: "unavailable" };
  }
  if (!result || result.error || !result.faces.length) return { status: "no_face" };
  const score = Math.max(...result.faces.map((f) => profileScore(f.embedding, profile)));
  return { status: score >= MATCH_THRESHOLD ? "verified" : "mismatch", score };
}

// Message that blocks a selfie punch, or null when the punch may go ahead.
// The face service being down never blocks a punch — the record is left
// "pending" for review instead.
function selfieRejection(check) {
  if (check?.status === "mismatch") {
    return "Your face didn't match the face enrolled for your account. Try again in good light, or ask your admin to re-enrol your face.";
  }
  if (check?.status === "no_face") {
    return "No face found in the selfie. Keep your face inside the frame and try again.";
  }
  return null;
}

module.exports = {
  MATCH_THRESHOLD,
  FaceServiceUnavailable,
  embedImages,
  isServiceUp,
  cosine,
  profileScore,
  tenantProfiles,
  invalidateTenant,
  matchFace,
  verifySelfie,
  selfieRejection,
};
