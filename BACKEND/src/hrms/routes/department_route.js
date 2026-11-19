const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const departmentController = require("../controllers/department_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/", hrmsManager(["view_departments"]), departmentController.createDepartment);
router.get("/", departmentController.getAllDepartments);
router.get("/:id", departmentController.getDepartmentById);
router.patch("/:id", hrmsManager(["view_departments"]), departmentController.updateDepartment);
router.delete("/:id", hrmsManager(["view_departments"]), departmentController.deleteDepartment);

module.exports = router;
