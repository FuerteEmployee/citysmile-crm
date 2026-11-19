const express = require("express");
const router = express.Router();
const {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  bulkCreateDepartment,
} = require("../controllers/department_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Support", "Create"), bulkCreateDepartment);

router
  .route("/")
  .get(checkPermission("Support", "View"), getDepartments)
  .post(checkPermission("Support", "Create"), createDepartment);

router
  .route("/:id")
  .put(checkPermission("Support", "Edit"), updateDepartment)
  .delete(checkPermission("Support", "Delete"), deleteDepartment);

module.exports = router;
