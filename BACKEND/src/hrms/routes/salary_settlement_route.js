const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const salarySettlementController = require("../controllers/salary_settlement_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

// Calculate/estimate settlement for an employee/month
router.post("/calculate-estimate", hrmsManager(["manage_payroll"]), salarySettlementController.calculateEstimate);

// Set brand slip amount and compute variance
router.patch("/set-brand-slip-amount", hrmsManager(["manage_payroll"]), salarySettlementController.setBrandSlipAmount);

// Mark a settlement as settled (finalize)
router.patch("/mark-settled", hrmsManager(["manage_payroll"]), salarySettlementController.markSettled);

// List settlements with filters
router.get("/list", salarySettlementController.listSettlements);

// Get settlement history for one employee
router.get("/history/:employeeId", salarySettlementController.getEmployeeSettlementHistory);

// Get summary (totals) for a month/year
router.get("/summary", salarySettlementController.getSettlementSummary);

// Delete a settlement record (settled records require ?force=true)
router.delete("/:id", hrmsManager(["manage_payroll"]), salarySettlementController.deleteSettlement);

module.exports = router;
