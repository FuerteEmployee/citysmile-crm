const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const userController = require("../controllers/user_controller");
const { bulkCreateEmployees } = require("../controllers/import_employees_controller");
const { protect } = require("../middleware/auth_middleware");
const { requirePermission } = require("../middleware/authorize");

// Tenant admins (CRM login) pass straight through; anyone else needs the
// HRMS Staff Directory permission.
const canManageStaff = (req, res, next) =>
  req.user?.admin || req.user?.is_superadmin ? next() : requirePermission("manage_users", "create_staff")(req, res, next);
const upload = require("../utils/cloudinary_config");

const userUpload = upload.any();

// Public (or specifically auth-less) route for login
router.post("/login", userController.login);
// Token refresh — verifies existing token signature (ignoreExpiration) and issues a new 30-day token
router.post("/refresh", userController.refreshToken);

// Protected routes (requires employee.manage permission, typically Store Admin/Owner)
router.post("/fcm-token", protect, userController.updateFcmToken);
router.post("/logout", protect, userController.logout);
router.post("/", protect, userUpload, userController.createUser);
router.get("/salespersons", protect, userController.getSalespersons);
router.get("/", protect, userController.getUsers);
// Bulk staff — before /:id so they aren't taken as an id.
router.post("/bulk-create", protect, canManageStaff, bulkCreateEmployees);
router.patch("/bulk-update", protect, canManageStaff, userController.bulkUpdateUsers);

// Device approval management (admin only)
router.get("/device-approvals", protect, hrmsManager(["manage_users"]), userController.getDeviceApprovals);
router.patch("/device-approvals/:id/approve", protect, hrmsManager(["manage_users"]), userController.approveDeviceRequest);
router.patch("/device-approvals/:id/reject", protect, hrmsManager(["manage_users"]), userController.rejectDeviceRequest);
router.patch("/device-approvals/:id/revoke", protect, hrmsManager(["manage_users"]), userController.revokeDeviceApproval);
router.get("/session-logs", protect, hrmsManager(["manage_users"]), userController.getSessionLogs);

router.get("/:id", protect, userController.getUserById);
router.put("/:id", protect, userUpload, userController.updateUser);
router.delete("/:id", protect, userController.deleteUser);

module.exports = router;
