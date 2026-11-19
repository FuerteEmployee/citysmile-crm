const express = require("express");
const router = express.Router();
const { chat, getHistory, clearHistory, getUsage } = require("../controllers/assistant_controller");
const { createVoiceLogs, getVoiceLogs } = require("../controllers/assistant_voice_log_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.post("/chat", protect, chat);
router.post("/voice-logs", protect, createVoiceLogs);
router.get("/voice-logs", protect, adminOnly, getVoiceLogs);
router.get("/history", protect, getHistory);
router.delete("/history", protect, clearHistory);
router.get("/usage", protect, getUsage);

module.exports = router;
