const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const attendanceController = require("../controllers/attendance_controller");
const { protect } = require("../middleware/auth_middleware");
const upload = require("../utils/cloudinary_config");

router.post("/punch-in", protect, upload.uploadMemory.single("selfie"), attendanceController.punchIn);
router.post("/punch-out", protect, upload.uploadMemory.single("selfie"), attendanceController.punchOut);
router.post("/auto-punch-out", protect, attendanceController.autoPunchOut);
router.get("/geo-fence/check", protect, attendanceController.checkGeoFence);
// Lunch in/out do not require a selfie.
router.post("/lunch-in", protect, attendanceController.lunchIn);
router.post("/lunch-out", protect, attendanceController.lunchOut);
router.get("/today", protect, attendanceController.getTodayAttendance);
router.get("/events/today", protect, attendanceController.getTodayEvents);
router.get("/history", protect, attendanceController.getAttendanceHistory);
router.get("/", protect, attendanceController.getAllAttendance);
router.get("/absent", protect, attendanceController.getAbsentEmployees);
router.get("/:id", protect, attendanceController.getAttendanceById);

router.patch("/admin-correct", protect, hrmsManager(["view_attendance"], { allowSupervisor: true }), attendanceController.adminCorrectPunch);
router.post("/import", protect, hrmsManager(["view_attendance"]), attendanceController.importAttendance);

router.post("/:id/regularize", protect, attendanceController.requestRegularization);
router.patch("/:id/approve", protect, hrmsManager(["view_attendance"], { allowSupervisor: true }), attendanceController.approveAttendance);
router.patch("/:id/reject", protect, hrmsManager(["view_attendance"], { allowSupervisor: true }), attendanceController.rejectAttendance);

module.exports = router;

