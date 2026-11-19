const express = require("express");
const router = express.Router();
const { getSettings, updateSettings, testEmail, testSms, getSystemInfo, getVersionInfo } = require("../controllers/setting_controller");
const { protect, optionalProtect, checkPermission } = require("../middleware/auth");

router.get("/", optionalProtect, getSettings);
router.post("/", protect, checkPermission("Settings", "Edit"), updateSettings);
router.get("/system-info", protect, checkPermission("Settings", "View"), getSystemInfo);
router.get("/version", protect, getVersionInfo);
router.post("/test-email", protect, checkPermission("Settings", "Edit"), testEmail);
router.post("/test-sms", protect, checkPermission("Settings", "Edit"), testSms);
// Setup > Settings > Tags: tags used on the company's records.
router.get("/tags", protect, checkPermission("Settings", "View"), require("../controllers/tag_controller").getTags);
router.delete("/tags/:tag", protect, checkPermission("Settings", "Edit"), require("../controllers/tag_controller").deleteTag);

module.exports = router;
