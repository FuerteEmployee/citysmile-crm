const express = require("express");
const router = express.Router();
const { getLeads, getLeadById, createLead, updateLead, updateLeadStatus, deleteLead, importLeads, convertToCustomer, markAsLost, markAsJunk, bulkDeleteLeads, bulkConvertToCustomer } = require("../controllers/lead_controller");
const { getOverview, getFollowUps, getConversions, updateConversion, setupPipelineStatuses } = require("../controllers/lead_insights_controller");
const { protect, staffOnly, adminOnly, checkPermission, requireCapability } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");

router.use(protect);
router.use(staffOnly);
router.use(checkPermission("Leads", "View"));

router.route("/")
  .get(getLeads)
  .post(createLead);

router.get("/overview", getOverview);
router.get("/follow-ups", requireTenantFeature("lead_followups"), getFollowUps);
router.get("/conversions", requireTenantFeature("patient_conversion"), getConversions);
router.put("/conversions/:id", requireTenantFeature("patient_conversion"), adminOnly, updateConversion);
router.post("/pipeline-statuses", adminOnly, setupPipelineStatuses);

router.post("/import", importLeads);
router.post("/bulk-delete", requireCapability("Leads", "Delete"), bulkDeleteLeads);
router.post("/bulk-convert", requireCapability("Leads", "Edit"), bulkConvertToCustomer);

router.post("/:id/convert", requireCapability("Leads", "Edit"), convertToCustomer);
router.patch("/:id/lost", markAsLost);
router.patch("/:id/junk", markAsJunk);

router.patch("/:id/status", updateLeadStatus);

router.route("/:id")
  .get(getLeadById)
  .put(updateLead)
  .delete(deleteLead);

module.exports = router;
