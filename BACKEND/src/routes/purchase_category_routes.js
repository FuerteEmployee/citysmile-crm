const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");
const {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  archiveCategory,
} = require("../controllers/purchase_category_controller");

// Only tenants with procurement_types enabled can access
router.use(protect, staffOnly, requireTenantFeature("procurement_types"), checkPermission("Purchases"));

router.get("/", listCategories);
router.get("/:id", getCategory);
router.post("/", createCategory);
router.put("/:id", updateCategory);
router.patch("/:id/archive", archiveCategory);

module.exports = router;

