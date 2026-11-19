const express = require("express");
const router = express.Router();
const locationController = require("../controllers/location_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

// Mints a long-lived, tracking-scoped JWT for the native background service so
// background syncs don't die when the short-lived login token expires mid-shift.
router.post("/tracking-token", locationController.issueTrackingToken);

router.post("/update", locationController.updateLocation);
router.post("/update/batch", locationController.batchUpdate);
router.get("/reverse-geocode", locationController.reverseGeocodeAddress);
router.get("/latest", locationController.getLatestLocations);
router.get("/path", locationController.getEmployeePath);
router.get("/routes", locationController.getEmployeeRoutes);
router.get("/routes/:routeId", locationController.getRouteDetails);
router.get("/geofence-audit", locationController.getGeofenceAuditLogs);

module.exports = router;
