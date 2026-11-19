const express = require("express");
const router = express.Router();
const {
  getPaymentModes,
  createPaymentMode,
  updatePaymentMode,
  deletePaymentMode,
  bulkCreatePaymentMode,
} = require("../controllers/payment_mode_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Settings", "Edit"), bulkCreatePaymentMode);
router.get("/", checkPermission("Settings", "View"), getPaymentModes);
router.post("/", checkPermission("Settings", "Edit"), createPaymentMode);
router.route("/:id")
  .patch(checkPermission("Settings", "Edit"), updatePaymentMode)
  .put(checkPermission("Settings", "Edit"), updatePaymentMode)
  .delete(checkPermission("Settings", "Edit"), deletePaymentMode);

module.exports = router;
