const express = require("express");
const router = express.Router();
const controller = require("../controllers/advance_salary_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/",    controller.createAdvanceSalary);
router.get("/",     controller.getAdvanceSalaries);
// Before /:id so "limit" isn't treated as a record id.
router.get("/limit/:employeeId", controller.getAdvanceLimit);
router.get("/loan-limit/:employeeId", controller.getLoanLimit);
router.get("/loan-policy", controller.getLoanPolicy);
router.put("/loan-policy", controller.updateLoanPolicy);
router.get("/:id",  controller.getAdvanceSalaryById);
router.put("/:id",  controller.updateAdvanceSalary);
router.post("/:id/repay", controller.recordRepayment);
router.delete("/:id", controller.deleteAdvanceSalary);

module.exports = router;
