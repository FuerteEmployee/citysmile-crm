const crypto = require("crypto");

// Signs/verifies calls between the Super Admin panel and a CRM server's
// /api/control API (server-to-server, no user login). Both sides share
// CONTROL_SECRET. The signature covers timestamp + method + path + exact body
// bytes, so a captured request can't be altered or replayed after MAX_SKEW_MS.

const MAX_SKEW_MS = 5 * 60 * 1000;

const sign = (secret, { timestamp, method, path, body }) =>
  crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${String(method).toUpperCase()}.${path}.${body || ""}`)
    .digest("hex");

/** Headers the Super Admin side sends. `body` must be the exact JSON string sent. */
const signedHeaders = (secret, { method, path, body }) => {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    "X-Control-Timestamp": timestamp,
    "X-Control-Nonce": nonce,
    "X-Control-Signature": sign(secret, { timestamp: `${timestamp}.${nonce}`, method, path, body }),
  };
};

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

module.exports = { sign, signedHeaders, safeEqualHex, MAX_SKEW_MS };
