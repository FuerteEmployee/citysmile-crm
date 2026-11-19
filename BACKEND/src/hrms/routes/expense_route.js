const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const controller = require("../controllers/expense_controller");
const { protect } = require("../middleware/auth_middleware");
const upload = require("../utils/cloudinary_config");

router.use(protect);

router.post("/", upload.single("receipt"), controller.createExpense);
router.get("/", controller.getExpenses);
router.get("/:id", controller.getExpenseById);
router.put("/:id", upload.single("receipt"), controller.updateExpense);
router.patch("/:id/status", hrmsManager(["manage_expenses"], { allowSupervisor: true }), controller.updateExpenseStatus);
router.delete("/:id", controller.deleteExpense);

module.exports = router;
