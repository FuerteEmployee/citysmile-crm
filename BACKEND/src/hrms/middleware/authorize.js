/**
 * authorize / requirePermission — role & permission guards that complement the
 * existing `protect` (JWT) and `admin` middleware.
 *
 * Usage:
 *   router.get("/x", protect, authorize("store_manager", "godown_manager"), ctrl)
 *   router.get("/y", protect, requirePermission("view_stock_dashboard"), ctrl)
 *
 * Super roles (admin/owner/super_admin) and the "*" permission always pass.
 */
const User = require("../models/user_model");

const SUPER_ROLES = ["admin", "owner", "super_admin"];

const mapCrmToHrms = (permissionsMap) => {
  if (!permissionsMap) return [];
  if (Array.isArray(permissionsMap)) return permissionsMap;
  if (permissionsMap instanceof Map) {
    // If it's a Mongoose Map, convert to a plain object
    permissionsMap = Object.fromEntries(permissionsMap);
  }

  const hrmsPerms = [];
  const getCap = (feat, cap) => {
    const featObj = permissionsMap[feat];
    if (!featObj) return false;
    if (Array.isArray(featObj)) return featObj.includes(cap);
    if (typeof featObj === "object") return featObj[cap] === true;
    return false;
  };

  // Branch Management
  if (getCap("HRMS Branch Management", "View(Global)")) hrmsPerms.push("view_branches");
  if (getCap("HRMS Branch Management", "Create")) hrmsPerms.push("create_branches");
  if (getCap("HRMS Branch Management", "Edit")) hrmsPerms.push("edit_branches");
  if (getCap("HRMS Branch Management", "Delete")) hrmsPerms.push("delete_branches");

  // Attendance
  if (getCap("HRMS Attendance", "View(Global)")) hrmsPerms.push("view_attendance");

  // Leaves
  if (getCap("HRMS Leave Management", "View(Global)")) hrmsPerms.push("view_leaves");

  // Expenses
  if (getCap("HRMS Expense Management", "View(Global)")) hrmsPerms.push("manage_expenses");

  // Payroll
  if (getCap("HRMS Salary Management", "View(Global)")) {
    hrmsPerms.push("view_payroll");
    hrmsPerms.push("manage_payroll");
  }

  // Shifts
  if (getCap("HRMS Shift Management", "View(Global)")) hrmsPerms.push("manage_shifts");

  // Staff
  if (getCap("HRMS Staff Directory", "View(Global)")) {
    hrmsPerms.push("manage_users");
    hrmsPerms.push("view_staff");
    hrmsPerms.push("create_staff");
  }

  // Departments
  if (getCap("HRMS Departments", "View(Global)")) hrmsPerms.push("view_departments");

  // Designations
  if (getCap("HRMS Designations", "View(Global)")) hrmsPerms.push("manage_designations");

  return hrmsPerms;
};

// Load the user's role key + permissions onto req.user (memoized per request).
const loadRole = async (req) => {
  if (req._roleLoaded) return req.user;
  const id = req.user && (req.user.userId || req.user.id || req.user._id);
  if (!id) return null;

  const user = await User.findById(id).populate("role");
  if (!user) return null;

  req.user.roleKey =
    user.role && typeof user.role === "object" ? (user.role.role || user.role.name || "") : String(user.role || "");
  req.user.permissions = user.role ? mapCrmToHrms(user.role.permissions) : [];
  req.user.storeId = user.storeId;
  req._roleLoaded = true;
  return req.user;
};

const authorize = (...roleKeys) => async (req, res, next) => {
  try {
    const u = await loadRole(req);
    if (!u) return res.status(401).json({ success: false, message: "Not authorized" });
    const rk = (u.roleKey || "").toLowerCase();
    if (SUPER_ROLES.includes(rk)) return next();
    if (roleKeys.map((r) => r.toLowerCase()).includes(rk)) return next();
    return res.status(403).json({ success: false, message: "Access denied for your role" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const requirePermission = (...perms) => async (req, res, next) => {
  try {
    const u = await loadRole(req);
    if (!u) return res.status(401).json({ success: false, message: "Not authorized" });
    const rk = (u.roleKey || "").toLowerCase();
    if (SUPER_ROLES.includes(rk)) return next();
    const userPerms = u.permissions || [];
    if (userPerms.includes("*")) return next();
    if (perms.some((p) => userPerms.includes(p))) return next();
    return res
      .status(403)
      .json({ success: false, message: "You don't have permission for this action" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Guard for HRMS admin actions: tenant admins/owners (CRM Staff.admin or HRMS
 * admin/owner role) always pass; others need one of `perms` on their HRMS role.
 * With allowSupervisor, branch supervisors also pass — the controller then
 * narrows them to their own branches via canActOnEmployee.
 */
const hrmsManager = (perms = [], { allowSupervisor = false } = {}) => async (req, res, next) => {
  try {
    const { isTenantAdmin, getBranchScope } = require("../utils/branchScope");
    if (await isTenantAdmin(req)) return next();
    const u = await loadRole(req);
    const mine = u?.permissions || [];
    if (mine.includes("*") || perms.some((p) => mine.includes(p))) return next();
    if (allowSupervisor && (await getBranchScope(req))) return next();
    return res.status(403).json({ success: false, message: "You don't have permission for this action" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { authorize, requirePermission, loadRole, hrmsManager };
