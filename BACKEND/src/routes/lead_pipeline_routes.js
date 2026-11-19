const express = require("express");
const router = express.Router();
const { getLeadStatuses, createLeadStatus, getLeadSources, createLeadSource } = require("../controllers/lead_pipeline_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/statuses")
  .get(checkPermission("Leads", "view"), getLeadStatuses)
  .post(checkPermission("Leads", "create"), createLeadStatus);

router.route("/sources")
  .get(checkPermission("Leads", "view"), getLeadSources)
  .post(checkPermission("Leads", "create"), createLeadSource);

module.exports = router;
