const express = require("express");
const router = express.Router();
const { getLogs, createLog } = require("../controllers/ticket_pipe_log_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Ticket Pipe Log", "View"));

router.route("/")
  .get(getLogs)
  .post(createLog);

module.exports = router;
