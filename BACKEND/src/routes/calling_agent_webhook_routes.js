const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  handleIncomingCall,
  handleCallEnded,
} = require("../controllers/calling_agent_webhook_controller");

// Exotel publishes no fixed IP range in their public docs (their support
// team gives out the current list on request), so this layer is opt-in:
// set EXOTEL_IP_ALLOWLIST to a comma-separated list once you have it from
// Exotel support. Unset = skipped, not "blocks everything".
function ipAllowlist(req, res, next) {
  const raw = process.env.EXOTEL_IP_ALLOWLIST;
  if (!raw) return next();
  const allowed = raw.split(",").map((ip) => ip.trim());
  const requestIp = req.ip || req.connection?.remoteAddress;
  if (allowed.includes(requestIp)) return next();
  return res.status(403).json({ error: "Forbidden" });
}

// Real call volume is bursty (several rings in the same minute is normal),
// but this is still a public, unauthenticated-by-Express endpoint — the
// webhook_token is the real gate, this is just a backstop against abuse.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/incoming/:webhookToken", ipAllowlist, webhookLimiter, handleIncomingCall);
router.post("/call-ended/:webhookToken", ipAllowlist, webhookLimiter, handleCallEnded);

module.exports = router;
