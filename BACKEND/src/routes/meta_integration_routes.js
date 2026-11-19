const express = require("express");
const router = express.Router();
const { getIntegration, connectPage, syncForms, importLeads, disconnect } = require("../controllers/meta_integration_controller");
const { protect, staffOnly, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(staffOnly);
router.use(checkPermission("Leads", "Edit"));

router.get("/", getIntegration);
router.post("/connect", connectPage);
router.post("/:pageId/sync", syncForms);
router.post("/:pageId/import-leads", importLeads);
router.delete("/:pageId", disconnect);

module.exports = router;
