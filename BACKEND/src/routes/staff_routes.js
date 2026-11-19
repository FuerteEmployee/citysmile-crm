const express = require("express");
const router = express.Router();
const {
  getStaff,
  getAssignableStaff,
  getStaffById,
  createStaff,
  importStaff,
  updateStaff,
  deleteStaff,
} = require("../controllers/staff_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");
const upload = require("../hrms/utils/cloudinary_config");

const staffUpload = upload.any();

router.use(protect);

// Task/project assignee pickers — any logged-in staff of the company.
router.get("/assignable", getAssignableStaff);

router.route("/")
  .get(checkPermission("Staff", "View"), getStaff)
  .post(checkPermission("Staff", "Create"), staffUpload, createStaff);

router.post("/import", checkPermission("Staff", "Create"), importStaff);

// checkPermission lets staff open/edit their own profile; the controller then
// refuses changes to their own role/permissions/active and self-delete.
router.route("/:id")
  .all(validIdParam("id"))
  .get(checkPermission("Staff", "View"), getStaffById)
  .put(checkPermission("Staff", "Edit"), staffUpload, updateStaff)
  .delete(checkPermission("Staff", "Delete"), deleteStaff);

module.exports = router;
