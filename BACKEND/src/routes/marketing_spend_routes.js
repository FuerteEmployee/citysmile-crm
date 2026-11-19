const express = require("express");
const router = express.Router();
const { listSpend, getSpendSummary, createSpend, updateSpend, deleteSpend } = require("../controllers/marketing_spend_controller");
const { protect, staffOnly, checkPermission, requireCapability } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");

// Enabled per company by the super admin (marketing_spend); per staff via the
// "Marketing Spend" role permission. Writes are enforced server-side.
router.use(protect, staffOnly, requireTenantFeature("marketing_spend"), checkPermission("Marketing Spend"));

router.get("/", listSpend);
router.get("/summary", getSpendSummary);
router.post("/", requireCapability("Marketing Spend", "Create"), createSpend);
router.put("/:id", requireCapability("Marketing Spend", "Edit"), updateSpend);
router.delete("/:id", requireCapability("Marketing Spend", "Delete"), deleteSpend);

module.exports = router;
