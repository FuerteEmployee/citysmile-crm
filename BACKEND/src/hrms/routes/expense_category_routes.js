const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const controller = require("../controllers/expense_category_controller");
const { protect } = require("../middleware/auth_middleware");

router.get("/", protect, controller.getAll);
router.post("/", protect, hrmsManager(["manage_expenses"]), controller.create);
router.put("/:id", protect, hrmsManager(["manage_expenses"]), controller.update);
router.delete("/:id", protect, hrmsManager(["manage_expenses"]), controller.delete);

module.exports = router;
