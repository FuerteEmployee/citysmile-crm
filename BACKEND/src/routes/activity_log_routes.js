const express = require("express");
const router = express.Router();
const { getLogs, createLog, deleteLog } = require("../controllers/activity_log_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Activity Log", "View"));

router.route("/")
  .get(getLogs)
  .post(createLog);

router.route("/:id")
  .delete(deleteLog);

module.exports = router;
