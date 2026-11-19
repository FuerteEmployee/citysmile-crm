const express = require("express");
const router = express.Router();
const { getGdprSettings, updateGdprSettings } = require("../controllers/gdpr_setting_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(getGdprSettings)
  .put(adminOnly, updateGdprSettings);

module.exports = router;
