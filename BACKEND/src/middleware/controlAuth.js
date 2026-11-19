const { sign, safeEqualHex, MAX_SKEW_MS } = require("../utils/controlSignature");

// Guards /api/control: only the Super Admin panel (holding CONTROL_SECRET) may
// call it. No user/JWT is involved, so a Super Admin never logs in on a client
// server. Off (404) unless CONTROL_SECRET is set on this server.
// Optional CONTROL_ALLOWED_IPS="1.2.3.4,5.6.7.8" adds an IP allow-list. It uses
// req.ip (X-Forwarded-For is NOT trusted, as this app sets no "trust proxy"), so
// behind nginx put the IP allow-list in nginx for /api/control instead.

const seenNonces = new Map(); // nonce -> expiry time (blocks replays inside the skew window)

const clientIp = (req) => String(req.ip || "").replace(/^::ffff:/, "");

const controlAuth = (req, res, next) => {
  const secret = process.env.CONTROL_SECRET;
  if (!secret || secret.length < 32) return res.status(404).json({ message: "Not found" });

  const allowIps = String(process.env.CONTROL_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowIps.length && !allowIps.includes(clientIp(req))) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const ts = req.get("X-Control-Timestamp");
  const nonce = req.get("X-Control-Nonce");
  const signature = req.get("X-Control-Signature");
  if (!ts || !nonce || !signature || !/^[a-f0-9]{32}$/.test(nonce)) {
    return res.status(401).json({ message: "Missing control signature" });
  }
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) {
    return res.status(401).json({ message: "Control request expired" });
  }

  const body = req.rawBody ? req.rawBody.toString("utf8") : "";
  const expected = sign(secret, { timestamp: `${ts}.${nonce}`, method: req.method, path: req.originalUrl, body });
  if (!safeEqualHex(signature, expected)) return res.status(401).json({ message: "Invalid control signature" });

  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return res.status(401).json({ message: "Control request already used" });
  seenNonces.set(nonce, now + MAX_SKEW_MS * 2);

  next();
};

module.exports = { controlAuth };
