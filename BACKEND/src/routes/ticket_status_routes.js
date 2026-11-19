const express = require("express");
const router = express.Router();
const {
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
  bulkCreateStatus,
} = require("../controllers/ticket_status_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Support", "Create"), bulkCreateStatus);

router
  .route("/")
  .get(checkPermission("Support", "View"), getStatuses)
  .post(checkPermission("Support", "Create"), createStatus);

router
  .route("/:id")
  .put(checkPermission("Support", "Edit"), updateStatus)
  .delete(checkPermission("Support", "Delete"), deleteStatus);

module.exports = router;
