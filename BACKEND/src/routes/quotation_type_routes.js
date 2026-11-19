const express = require("express");
const router = express.Router();
const {
  getQuotationTypes,
  createQuotationType,
  updateQuotationType,
  deleteQuotationType,
  reorderQuotationTypes,
} = require("../controllers/quotation_type_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(checkPermission("Quotations", "View"), getQuotationTypes)
  .post(checkPermission("Settings", "Create"), createQuotationType);

// Must come before "/:id" — otherwise Express would match this as
// PUT /:id with id="reorder".
router.route("/reorder").put(checkPermission("Settings", "Edit"), reorderQuotationTypes);

router.route("/:id")
  .put(checkPermission("Settings", "Edit"), updateQuotationType)
  .delete(checkPermission("Settings", "Delete"), deleteQuotationType);

module.exports = router;
