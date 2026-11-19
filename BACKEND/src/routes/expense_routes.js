const express = require("express");
const router = express.Router();
const { getExpenses, createExpense, deleteExpense, updateExpense } = require("../controllers/expense_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Expenses", "View"));

router.route("/")
  .get(getExpenses)
  .post(createExpense);

router.route("/:id")
  .put(updateExpense)
  .delete(deleteExpense);

module.exports = router;
