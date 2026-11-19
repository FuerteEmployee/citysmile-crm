const express = require("express");
const router = express.Router();
const {
  getVendors,
  getVendorById,
  getVendorPurchases,
  createVendor,
  updateVendor,
  deleteVendor,
  importVendors,
  bulkDeleteVendors,
} = require("../controllers/vendor_controller");
const { protect, checkPermission, requireCapability } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");

router.use(protect);
// View is required for every vendor endpoint; writes additionally need the
// matching Create / Edit / Delete capability (checkPermission only checks View).
router.use(checkPermission("Vendors", "View"));

router.route("/")
  .get(getVendors)
  .post(requireCapability("Vendors", "Create"), createVendor);

router.post("/import", requireCapability("Vendors", "Create"), importVendors);
router.post("/bulk-delete", requireCapability("Vendors", "Delete"), bulkDeleteVendors);

router.get("/:id/purchases", validIdParam("id"), getVendorPurchases);

router.route("/:id")
  .all(validIdParam("id"))
  .get(getVendorById)
  .put(requireCapability("Vendors", "Edit"), updateVendor)
  .delete(requireCapability("Vendors", "Delete"), deleteVendor);

module.exports = router;
