const express = require("express");
const router = express.Router();
const {
  getCurrencies,
  createCurrency,
  updateCurrency,
  deleteCurrency,
  bulkCreateCurrency,
} = require("../controllers/currency_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Settings", "Edit"), bulkCreateCurrency);
router.get("/", checkPermission("Settings", "View"), getCurrencies);
router.post("/", checkPermission("Settings", "Edit"), createCurrency);
router.route("/:id")
  .patch(checkPermission("Settings", "Edit"), updateCurrency)
  .put(checkPermission("Settings", "Edit"), updateCurrency)
  .delete(checkPermission("Settings", "Edit"), deleteCurrency);

module.exports = router;
