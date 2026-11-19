const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const leaveController = require("../controllers/leave_controller");
const { protect } = require("../middleware/auth_middleware");

// Apply auth middleware to all routes
router.use(protect);

// Leave Requests
router.post("/requests", leaveController.createLeaveRequest);
router.get("/requests", leaveController.getLeaveRequests);
router.patch("/requests/:id/status", leaveController.updateLeaveStatus);

// Leave Balances
router.get("/balances", leaveController.getLeaveBalances);

// Leave Types
router.post("/types", hrmsManager(["view_leaves"]), leaveController.createLeaveType);
router.get("/types", leaveController.getLeaveTypes);

module.exports = router;
