const express = require("express");
const router = express.Router();
const vapiController = require("../controllers/vapi_webhook_controller");

// GET — Vapi pings this URL to validate it during tool setup
router.get("/", (req, res) => {
  res.status(200).json({ status: "ok", service: "Vapi Webhook Active" });
});

// POST — Vapi sends call events (function-call, end-of-call-report, etc.)
router.post("/", vapiController.handleVapiWebhook);

module.exports = router;
