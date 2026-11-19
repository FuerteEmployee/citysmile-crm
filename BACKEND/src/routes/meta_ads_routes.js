const express = require("express");
const router = express.Router();
const {
  listAccounts,
  previewPages,
  accountPages,
  connectAccount,
  updateAccount,
  disconnectAccount,
  syncNow,
} = require("../controllers/meta_ads_controller");
const { protect, staffOnly, adminOnly, checkPermission, requireCapability } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");

// Only for companies the super admin enabled Marketing Spend for. Viewing
// needs the "Marketing Spend" role permission; connecting/changing an ad
// account's credentials is limited to the company's admins.
router.use(protect, staffOnly, requireTenantFeature("marketing_spend"), checkPermission("Marketing Spend"));

router.get("/accounts", listAccounts);
router.post("/pages", adminOnly, previewPages);
router.get("/accounts/:id/pages", adminOnly, accountPages);
router.post("/accounts", adminOnly, connectAccount);
router.patch("/accounts/:id", adminOnly, updateAccount);
router.delete("/accounts/:id", adminOnly, disconnectAccount);
router.post("/sync", requireCapability("Marketing Spend", "Edit"), syncNow);

module.exports = router;
