const express = require("express");
const router = express.Router();
const {
  getTaxes,
  createTax,
  updateTax,
  deleteTax,
  bulkCreateTax,
} = require("../controllers/tax_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Settings", "Edit"), bulkCreateTax);
router.get("/", checkPermission("Settings", "View"), getTaxes);
router.post("/", checkPermission("Settings", "Edit"), createTax);
router.route("/:id")
  .patch(checkPermission("Settings", "Edit"), updateTax)
  .put(checkPermission("Settings", "Edit"), updateTax)
  .delete(checkPermission("Settings", "Edit"), deleteTax);

module.exports = router;
