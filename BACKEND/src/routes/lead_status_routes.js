const express = require("express");
const router = express.Router();
const {
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  deleteLeadStatus,
  bulkCreateStatus,
} = require("../controllers/lead_status_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.get("/", checkPermission("Leads", "View"), getLeadStatuses);
router.post("/bulk", checkPermission("Leads", "Create"), bulkCreateStatus);
router.post("/", checkPermission("Leads", "Create"), createLeadStatus);
router.patch("/:id", checkPermission("Leads", "Edit"), updateLeadStatus);
router.delete("/:id", checkPermission("Leads", "Delete"), deleteLeadStatus);

module.exports = router;
