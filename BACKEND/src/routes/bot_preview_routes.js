const express = require("express");
const router = express.Router();
const { botPreview } = require("../controllers/bot_preview_controller");

// Deliberately no auth middleware — crawlers never carry a session/token.
router.get("/", botPreview);

module.exports = router;
