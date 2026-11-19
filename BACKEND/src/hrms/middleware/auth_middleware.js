const jwt = require("jsonwebtoken");
const User = require("../models/user_model");
const Staff = require("../../models/Staff");
const { rejectIfTenantBlocked } = require("../../utils/tenantAccess");

exports.protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Not authorized" });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    if (!token) {
      return res.status(401).json({ message: "Not authorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Tokens issued by the main CRM staff login are shaped { id, role } —
    // `id` is a Staff._id, a different collection/document from this
    // module's own User model, not interchangeable with it. Resolve the
    // real HRMS User._id via the email link every HRMS controller relies on
    // (see user_controller.js's Staff-linking) so `req.user.userId` always
    // points at the right employee record, regardless of which login issued
    // the token. Without this, controllers using `req.user.userId ||
    // req.user.id` as a fallback would silently save/read data against the
    // wrong id (a Staff._id where a User._id was expected).
    if (!req.user.userId && req.user.id) {
      const staff = await Staff.findById(req.user.id).select("email tenant_id is_superadmin admin hrms_user_id");
      if (staff?.hrms_user_id) {
        req.user.userId = String(staff.hrms_user_id);
      } else if (staff?.email) {
        // Same company only — another company may have a profile with this email.
        const hrmsUser = await User.findOne({ email: staff.email, tenant_id: staff.tenant_id || null }).select("_id");
        if (hrmsUser) req.user.userId = String(hrmsUser._id);
      }
      // Staff is the tenant source of truth for a bridged token — use it directly
      // rather than re-reading tenant_id off the (possibly not-yet-backfilled) User doc.
      if (staff) {
        req.user.tenant_id = staff.tenant_id || null;
        req.user.is_superadmin = !!staff.is_superadmin;
        // Tenant-level admin/owner (distinct from platform is_superadmin) —
        // Staff.admin is the only place this actually lives for a bridged
        // token, since the linked HRMS User record has no equivalent field.
        req.user.admin = !!staff.admin;
      }
    }

    // Tokens issued by HRMS's own /login are already { userId }, so the branch above
    // never runs — resolve tenant_id straight from the User doc instead. Every HRMS
    // controller (getUsers/getUserById/createUser/updateUser/deleteUser etc.) relies on
    // req.user.tenant_id to keep different tenants' employees from mixing together.
    if (req.user.tenant_id === undefined && req.user.userId) {
      const hrmsUser = await User.findById(req.user.userId).select("tenant_id");
      req.user.tenant_id = hrmsUser?.tenant_id || null;
    }

    // One Suspend switch covers the HRMS module and the HRMS app too.
    if (await rejectIfTenantBlocked(res, req.user.tenant_id, { isSuperadmin: req.user.is_superadmin })) return;

    next();
  } catch (err) {
    return res
      .status(401)
      .json({ message: "Not authorized", error: err.message });
  }
};

exports.admin = async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return res.status(403).json({ message: "Access denied. Admin permissions required." });
    }

    const user = await User.findById(userId).populate("role");
    if (!user) {
      return res.status(403).json({ message: "Access denied. User not found." });
    }

    const roleName = user.role && typeof user.role === "object"
      ? user.role.role
      : String(user.role);

    if (roleName === "admin" || roleName === "owner" || roleName === "super_admin") {
      req.user.role = user.role; // store role object in request for downstream use
      next();
    } else {
      res.status(403).json({ message: "Access denied. Admin permissions required." });
    }
  } catch (err) {
    res.status(500).json({ message: "Server error checking permissions", error: err.message });
  }
};

// Lightweight tenant-admin gate for a Staff-bridged token (see protect above) —
// req.user.admin/is_superadmin are only set there, not by exports.admin's
// HRMS-User-role check, which a bridged backfilled User record never has.
exports.requireAdmin = (req, res, next) => {
  if (req.user?.admin || req.user?.is_superadmin) return next();
  return res.status(403).json({ message: "Access denied. Admin permissions required." });
};
