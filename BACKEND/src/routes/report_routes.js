const express = require("express");
const router = express.Router();
const { getFinancialReport, getSalesReport, getExpensesReport, getPurchaseReport } = require("../controllers/report_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Reports", "View"));

router.get("/financial", getFinancialReport);
router.get("/sales", getSalesReport);
router.get("/expenses", getExpensesReport);
router.get("/purchase", getPurchaseReport);

module.exports = router;
