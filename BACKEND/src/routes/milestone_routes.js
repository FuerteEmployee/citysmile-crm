const express = require("express");
const router = express.Router();
const { getMilestones, createMilestone } = require("../controllers/milestone_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(checkPermission("Projects", "view"), getMilestones)
  .post(checkPermission("Projects", "edit"), createMilestone);

module.exports = router;
