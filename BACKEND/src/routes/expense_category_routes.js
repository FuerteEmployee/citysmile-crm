const express = require("express");
const router = express.Router();
const {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  bulkCreateExpenseCategory,
} = require("../controllers/expense_category_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Settings", "Edit"), bulkCreateExpenseCategory);
router.get("/", checkPermission("Settings", "View"), getExpenseCategories);
router.post("/", checkPermission("Settings", "Edit"), createExpenseCategory);
router.route("/:id")
  .patch(checkPermission("Settings", "Edit"), updateExpenseCategory)
  .put(checkPermission("Settings", "Edit"), updateExpenseCategory)
  .delete(checkPermission("Settings", "Edit"), deleteExpenseCategory);

module.exports = router;
