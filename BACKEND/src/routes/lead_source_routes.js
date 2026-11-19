const express = require("express");
const router = express.Router();
const {
  getLeadSources,
  createLeadSource,
  updateLeadSource,
  deleteLeadSource,
  bulkCreateSource,
} = require("../controllers/lead_source_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.get("/", checkPermission("Leads", "View"), getLeadSources);
router.post("/bulk", checkPermission("Leads", "Create"), bulkCreateSource);
router.post("/", checkPermission("Leads", "Create"), createLeadSource);
router.patch("/:id", checkPermission("Leads", "Edit"), updateLeadSource);
router.delete("/:id", checkPermission("Leads", "Delete"), deleteLeadSource);

module.exports = router;
