const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const payrollController = require("../controllers/payroll_controller");
const { protect } = require("../middleware/auth_middleware");
const { requirePermission } = require("../middleware/authorize");

// Tenant admins (CRM login) pass straight through; others need the payroll permission.
const canViewPayroll = (req, res, next) =>
  req.user?.admin || req.user?.is_superadmin ? next() : requirePermission("view_payroll", "manage_payroll")(req, res, next);

router.use(protect);

// PF Records — before the /:id routes so "pf-records" isn't taken as an id.
router.get("/pf-records", canViewPayroll, payrollController.getPfRecords);
router.get("/pf-records/me", payrollController.getMyPfRecords);

router.post("/generate", hrmsManager(["manage_payroll"]), payrollController.generatePayroll);
router.get("/", payrollController.getPayrollRecords);
// Self-service routes — must come before the generic /:id / :payrollId
// routes below so "me" isn't swallowed as an id param.
router.get("/me", payrollController.getMyPayrollRecords);
router.get("/me/:payrollId/slip", payrollController.getMyPayrollSlip);
router.patch("/:id/approve", hrmsManager(["manage_payroll"]), payrollController.approvePayroll);
router.patch("/:id/pay", hrmsManager(["manage_payroll"]), payrollController.markAsPaid);
router.get("/:payrollId/slip", payrollController.getPayrollSlip);
router.delete("/:id", hrmsManager(["manage_payroll"]), payrollController.deletePayrollRecord);

module.exports = router;
