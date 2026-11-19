const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Staff = require("../models/Staff");
const Contact = require("../models/Contact");
const Tenant = require("../models/Tenant");
const { rejectIfTenantBlocked } = require("../utils/tenantAccess");
const { lockedTenantId, singleTenantBlock } = require("../utils/singleTenant");

// Self-heals a tenant owner's Staff.tenant_id if it was never linked —
// mirrors auth_controller.resolveTenant so every authenticated request
// (not just fresh logins) sees a correct tenant_id for filtering.
// Single-company server: the only company is TENANT_ID (never a super admin).
const healTenantId = async (staff) => {
  if (staff.tenant_id || staff.is_superadmin) return;
  const locked = lockedTenantId();
  const tenant = locked ? await Tenant.findById(locked).select("_id") : null;
  if (tenant) {
    staff.tenant_id = tenant._id;
    await Staff.findByIdAndUpdate(staff._id, { tenant_id: tenant._id });
  }
};

const ENCRYPTION_KEY = Buffer.from(
  process.env.COOKIE_ENCRYPTION_KEY || "01234567890123456789012345678901",
  "utf8"
); // 32 bytes — must match auth_controller fallback
const IV_LENGTH = 16; // AES expects a 16-byte IV

const decryptToken = (text) => {
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    if (iv.length !== IV_LENGTH) {
      // Not our encrypted format (e.g. a stale/foreign cookie) — treat as unauthenticated.
      return null;
    }
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.warn("Token decryption failed:", error.message);
    return null;
  }
};

const protect = async (req, res, next) => {
  let token;

  // Check for token in cookies first
  if (req.cookies && req.cookies.token) {
    const decryptedToken = decryptToken(req.cookies.token);
    if (decryptedToken) {
      token = decryptedToken;
    }
  }
  
  // Fallback to Authorization header if cookie token is missing or invalid
  if (
    !token &&
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (token) {
    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from the token
      if (decoded.role === "staff") {
        req.user = await Staff.findById(decoded.id).select("-password");
        req.userRole = "staff";
      } else {
        req.user = await Contact.findById(decoded.id).select("-password");
        req.userRole = "contact";
      }

      if (!req.user) {
        return res
          .status(401)
          .json({ message: "Not authorized, user not found" });
      }

      if (req.userRole === "staff") {
        if (req.user.active === false) {
          return res.status(401).json({ code: "ACCOUNT_DEACTIVATED", message: "Account is deactivated" });
        }
        await healTenantId(req.user);
        // Suspended (or deleted) company: block every API call, not just login.
        if (await rejectIfTenantBlocked(res, req.user.tenant_id, { isSuperadmin: req.user.is_superadmin })) return;
      }

      next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({ code: "TOKEN_EXPIRED", message: "Session expired, please log in again" });
      }
      if (error.name === "JsonWebTokenError") {
        return res.status(401).json({ code: "TOKEN_INVALID", message: "Not authorized, token failed" });
      }
      console.error("[auth] unexpected error:", error);
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  if (!token) {
    res.status(401).json({ message: "Not authorized, no token" });
  }
};

const optionalProtect = async (req, res, next) => {
  let token;

  if (req.cookies && req.cookies.token) {
    const decryptedToken = decryptToken(req.cookies.token);
    if (decryptedToken) token = decryptedToken;
  } 
  
  if (
    !token &&
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role === "staff") {
        req.user = await Staff.findById(decoded.id).select("-password");
        req.userRole = "staff";
        // Mirror protect(): link a tenant owner's missing tenant_id so
        // reads resolve the same tenant scope that writes are saved to
        if (req.user) await healTenantId(req.user);
        // Super Admin / other company on this single-company server: treat as logged out.
        if (req.user && singleTenantBlock(req.user.tenant_id, { isSuperadmin: req.user.is_superadmin })) {
          req.user = undefined;
          req.userRole = undefined;
        }
      }
    } catch (_) {
      // invalid token — continue as unauthenticated
    }
  }

  next();
};

const adminOnly = (req, res, next) => {
  if (req.userRole === "staff" && req.user && (req.user.admin || req.user.is_superadmin)) {
    next();
  } else {
    res.status(403).json({ message: "Forbidden, admin access only" });
  }
};

const staffOnly = (req, res, next) => {
  if (req.userRole === "staff") {
    next();
  } else {
    res.status(403).json({ message: "Forbidden, staff access only" });
  }
};

// Resolves one capability (e.g. "Edit") for a module from the same staff/role
// permission maps checkPermission reads. Admins and superadmins always pass.
const hasCapability = async (req, module, cap) => {
  if (req.userRole !== "staff" || !req.user) return false;
  if (req.user.admin || req.user.is_superadmin) return true;

  let role = req.user.role;
  if (role && (typeof role === "string" || role instanceof require("mongoose").Types.ObjectId)) {
    const Role = require("../models/Role");
    role = await Role.findById(role);
    req.user.role = role;
  }
  const getPerms = (permObj) => {
    if (!permObj) return {};
    if (permObj instanceof Map) return permObj.get(module) || {};
    return permObj[module] || {};
  };
  const staffPerms = getPerms(req.user.permissions);
  const rolePerms = getPerms(role?.permissions);
  return !!(staffPerms[cap] ?? rolePerms[cap] ?? false);
};

// Unlike checkPermission (View-only), this actually enforces Create/Edit/Delete
// server-side, for endpoints where a frontend-only check isn't enough.
const requireCapability = (module, cap) => async (req, res, next) => {
  try {
    if (await hasCapability(req, module, cap)) return next();
    return res.status(403).json({ message: `Forbidden: no ${cap} permission for ${module}` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * Middleware to check View permission for a module.
 * Sets req.permissionLevel to 'global' or 'own' so controllers can filter data.
 * Admins always bypass and get 'global' access.
 *
 * @param {string} module - Module name matching FEATURES_CONFIG (e.g. 'Invoices', 'Staff')
 * @param {string} action - Should always be 'View' — Create/Edit/Delete are handled by the frontend
 */
const checkPermission = (module, action = "View") => {
  return async (req, res, next) => {
    if (req.userRole !== "staff") {
      return res.status(403).json({ message: "Forbidden, staff access only" });
    }

    // Admins and Superadmins bypass all permission checks — they see everything
    if (req.user.admin || req.user.is_superadmin) {
      req.permissionLevel = "global";
      return next();
    }

    // Allow staff members to view or edit their own profile details
    if (module === "Staff" && req.params?.id && req.params.id === req.user?._id?.toString()) {
      req.permissionLevel = "own";
      return next();
    }

    // Load role document if role is just an ObjectId/string
    let user = req.user;
    if (
      user.role &&
      (typeof user.role === "string" ||
        user.role instanceof require("mongoose").Types.ObjectId)
    ) {
      const Role = require("../models/Role");
      const roleDoc = await Role.findById(user.role);
      user.role = roleDoc;
    }

    // Helper to read from Mongoose Map or plain object
    const getPerms = (permObj, mod) => {
      if (!permObj) return {};
      if (permObj instanceof Map) return permObj.get(mod) || {};
      return permObj[mod] || {};
    };

    const rolePerms = getPerms(user.role?.permissions, module);
    const staffPerms = getPerms(user.permissions, module);

    // Staff-level override takes precedence over role-level
    const hasCap = (cap) => staffPerms[cap] ?? rolePerms[cap] ?? false;

    const normalizedAction = action ? String(action).trim().toLowerCase() : "view";

    // If an explicit action capability like Create/Edit/Delete is requested, verify it
    if (normalizedAction !== "view") {
      const capKey = ["Create", "Edit", "Delete", "View(Global)", "View (Own)", action].find(
        (c) => c.toLowerCase() === normalizedAction
      ) || action;

      if (!hasCap(capKey)) {
        return res.status(403).json({
          message: `Forbidden: no ${action} permission for ${module}`,
        });
      }
    }

    const canViewGlobal = hasCap("View(Global)");
    const canViewOwn = hasCap("View (Own)");

    if (canViewGlobal) {
      req.permissionLevel = "global";
      return next();
    }

    if (canViewOwn) {
      req.permissionLevel = "own";
      return next();
    }

    if (normalizedAction !== "view") {
      req.permissionLevel = "own";
      return next();
    }

    return res.status(403).json({
      message: `Forbidden: no View permission for ${module}`,
    });
  };
};

// City Smile server: the Trinetra pilot features are not part of this CRM.
const isTrinetraPilotUser = () => false;

const trinetraPilotOnly = (req, res, next) => {
  if (!isTrinetraPilotUser(req.user)) {
    return res.status(403).json({ message: "Not available" });
  }
  next();
};

// City Smile server: Ekagra-only rules are not part of this CRM.
const isEkagraUser = () => false;

// Bank Details is shared by the Trinetra pilot tenant and Ekagra Engineering,
// kept as its own check rather than folded into isTrinetraPilotUser since that
// flag also gates unrelated Trinetra-only features.
const canAccessBankDetails = (user) => isTrinetraPilotUser(user) || isEkagraUser(user);

const bankDetailsOnly = (req, res, next) => {
  if (!canAccessBankDetails(req.user)) {
    return res.status(403).json({ message: "Not available" });
  }
  next();
};

module.exports = {
  protect,
  optionalProtect,
  adminOnly,
  staffOnly,
  checkPermission,
  hasCapability,
  requireCapability,
  isTrinetraPilotUser,
  trinetraPilotOnly,
  isEkagraUser,
  canAccessBankDetails,
  bankDetailsOnly,
  decryptToken,
};
