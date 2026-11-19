const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const { getIntegrations, connect, updateToken, setLiveMode, disconnect } = require("../controllers/whatsapp_integration_controller");

router.use(protect, staffOnly, checkPermission("WhatsApp", "Edit"));

router.get("/", getIntegrations);
router.post("/connect", connect);
router.patch("/:id/token", updateToken);
router.patch("/:id/live-mode", setLiveMode);
router.delete("/:id", disconnect);

module.exports = router;
