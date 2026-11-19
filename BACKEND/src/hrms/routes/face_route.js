const express = require("express");
const router = express.Router();
const faceController = require("../controllers/face_controller");
const { protect } = require("../middleware/auth_middleware");
const { requirePermission } = require("../middleware/authorize");
const { requireTenantFeature } = require("../../utils/tenantFeatures");
const upload = require("../utils/cloudinary_config");

// Face Attendance setup + kiosk: tenant admins (CRM login) pass straight
// through; others need attendance or staff access. Supervisors are further
// limited to their branches' staff inside the controller.
const canManageFace = (req, res, next) =>
  req.user?.admin || req.user?.is_superadmin
    ? next()
    : requirePermission("view_attendance", "manage_users")(req, res, next);

router.use(protect);

// Whether the company has Face Attendance + whether I'm enrolled — answered
// even when the feature is off, so the UI knows to hide it.
router.get("/me", faceController.getMyFace);

// Everything else only for companies the super admin enabled it for
// (Super Admin > Companies > Manage > "HRMS Face Attendance").
router.use(requireTenantFeature("face_attendance"));

router.get("/status", canManageFace, faceController.getStatus);
router.get("/enrollments", canManageFace, faceController.listEnrollments);
router.get("/enrollments/:userId", canManageFace, faceController.getEnrollment);
router.post("/enrollments/:userId", canManageFace, upload.uploadMemory.array("photos", 5), faceController.enrollFace);
router.delete("/enrollments/:userId", canManageFace, faceController.removeEnrollment);

router.post("/kiosk/recognize", canManageFace, upload.uploadMemory.single("frame"), faceController.kioskRecognize);
router.post("/kiosk/punch", canManageFace, upload.uploadMemory.single("frame"), faceController.kioskPunch);

module.exports = router;
