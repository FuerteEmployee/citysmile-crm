const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const { requireTenantFeature } = require("../utils/tenantFeatures");
const {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} = require("../controllers/factory_location_controller");

router.use(protect, staffOnly, requireTenantFeature("procurement_types"), checkPermission("Purchases"));

router.get("/", listLocations);
router.post("/", createLocation);
router.put("/:id", updateLocation);
router.delete("/:id", deleteLocation);

module.exports = router;

