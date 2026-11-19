const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Staff = require("../models/Staff");
const Tenant = require("../models/Tenant");
const Contact = require("../models/Contact");
const ActivityLog = require("../models/ActivityLog");
const { getRequestHost, resolveTenantByHost } = require("../utils/resolveTenantByHost");
const { isTrinetraPilotUser } = require("../middleware/auth");
const { rejectIfTenantBlocked } = require("../utils/tenantAccess");
const EmailService = require("../services/EmailService");
// The device-lock/approval feature originally only existed on the HRMS User
// login (src/hrms/controllers/user_controller.js) — Setup > Staff's own
// login never enforced it. Reusing the same DeviceApproval collection and
// HRMS User record (via Staff.hrms_user_id) means a device request made from
// either login shows up on the same existing "Device Approvals" HRMS page,
// no new UI/module needed.
const HrmsUser = require("../hrms/models/user_model");
const DeviceApproval = require("../hrms/models/device_approval_model");
const SessionLog = require("../hrms/models/session_log_model");
const { getISTDate, getISTTime } = require("../hrms/utils/timeUtils");
const { reverseGeocode } = require("../hrms/utils/geocode");

const getClientIp = (req) => {
  let ip = req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.ip || "127.0.0.1";
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip === "::1" || ip === "::ffff:127.0.0.1") ip = "127.0.0.1";
  return ip;
};

// Every staff-login 2FA decision is made here, server-side, from the
// resolved tenant only — the frontend never decides this, it only reacts to
// `two_factor_auth_enabled` in the login response.
//
// The pilot email identifies a TENANT (its owner), not a single account:
// every staff member under that tenant gets 2FA, not just the owner. The
// owner lookup only has to succeed once per server run — cache the matching
// tenant id so normal logins don't pay for an extra query every time.
let pilotTenantId = null;
const isPilotTenant = async (tenant) => {
  if (!tenant?._id) return false;
  if (pilotTenantId) return String(tenant._id) === pilotTenantId;
  if (!tenant.owner_id) return false;
  const owner = await Staff.findById(tenant.owner_id).select("email").lean();
  if (!isTrinetraPilotUser(owner)) return false;
  pilotTenantId = String(tenant._id);
  return true;
};

const logLogin = (staff) => {
  ActivityLog.create({
    description: `${staff.firstname} ${staff.lastname} logged in`,
    staffid: staff._id,
    tenant_id: staff.tenant_id?._id || staff.tenant_id,
    date: new Date(),
  }).catch((err) => console.error("[ActivityLog] login log failed:", err.message));
};

const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: "10h",
  });
};

// Refresh tokens use a separate secret so a refresh token can never be replayed
// as an access token (protect() verifies access tokens with JWT_SECRET only).
const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || `${process.env.JWT_SECRET}_refresh`;

const generateRefreshToken = (id, role) => {
  return jwt.sign({ id, role, type: "refresh" }, REFRESH_SECRET, {
    expiresIn: "30d",
  });
};

const ENCRYPTION_KEY = Buffer.from(
  process.env.COOKIE_ENCRYPTION_KEY || "01234567890123456789012345678901",
  "utf8",
); // 32 bytes
const IV_LENGTH = 16; // AES expects a 16-byte IV

const encryptToken = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
};

const setTokenCookie = (res, token) => {
  const encryptedToken = encryptToken(token);
  const isProduction = process.env.NODE_ENV === "production";
  
  res.cookie("token", encryptedToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 10 * 60 * 60 * 1000, // 10 hours
  });
};

const mergePermissions = (staff) => {
  if (staff.admin) return null;

  const rolePermissions = staff.role?.permissions || {};
  const staffOverrides = staff.permissions || {};

  // Convert Mongoose Map to plain object if necessary
  const rolePermsObj =
    rolePermissions instanceof Map
      ? Object.fromEntries(rolePermissions)
      : rolePermissions;
  const staffOverridesObj =
    staffOverrides instanceof Map
      ? Object.fromEntries(staffOverrides)
      : staffOverrides;

  const merged = { ...rolePermsObj };

  for (const [feature, caps] of Object.entries(staffOverridesObj)) {
    merged[feature] = {
      ...(merged[feature] || {}),
      ...(caps || {}),
    };
  }

  return merged;
};

// For admin accounts where tenant_id isn't set on the Staff document, look up by owner_id.
// Also heals the broken link so the next login uses the fast path.
const resolveTenant = async (staff) => {
  if (staff.tenant_id) {
    if (typeof staff.tenant_id === 'object' && staff.tenant_id._id) return staff.tenant_id;
    const fullTenant = await Tenant.findById(staff.tenant_id)
      .populate("plan_id", "name price billing_cycle trial_days banner_warning_days module_access");
    if (fullTenant) return fullTenant;
  }
  let tenant = null;
  if (staff.admin) {
    tenant = await Tenant.findOne({ owner_id: staff._id })
      .populate("plan_id", "name price billing_cycle trial_days banner_warning_days module_access");
  }
  if (!tenant) {
    const tenantCount = await Tenant.countDocuments();
    if (tenantCount === 1) {
      tenant = await Tenant.findOne()
        .populate("plan_id", "name price billing_cycle trial_days banner_warning_days module_access");
    }
  }
  if (tenant) {
    await Staff.findByIdAndUpdate(staff._id, { tenant_id: tenant._id });
    staff.tenant_id = tenant._id;
  }
  return tenant || null;
};

// Returns true if `staff` is allowed to log in from the domain the request
// came from. Domains with no dedicated tenant (e.g. the generic multi-tenant
// crm.beontimeofficial.com) impose no restriction. Platform super admins can
// always log in, since they manage every tenant.
const isAllowedOnRequestDomain = async (req, staff, staffTenant) => {
  if (staff.is_superadmin) return true;
  const hostTenant = await resolveTenantByHost(getRequestHost(req));
  if (!hostTenant) return true;
  return !!staffTenant && String(staffTenant._id) === String(hostTenant._id);
};

const DOMAIN_LOCK_MESSAGE =
  "This account isn't registered for this portal. Please use your organization's login page.";

// Mirrors the HRMS User login's device-lock (src/hrms/controllers/
// user_controller.js) but resolves the linked HRMS User via Staff.hrms_user_id
// so a request raised here lands in the exact same DeviceApproval collection
// — the existing "Device Approvals" HRMS page needs no changes to show it.
// Non-fatal by design: any lookup failure just skips the check rather than
// blocking a login that would otherwise succeed.
const checkDeviceApproval = async (staff, deviceId, deviceInfo) => {
  if (!deviceId || staff.admin || staff.is_superadmin) return { blocked: false, hrmsUser: null };

  try {
    const hrmsUser = staff.hrms_user_id
      ? await HrmsUser.findById(staff.hrms_user_id)
      : await HrmsUser.findOne({ email: staff.email, tenant_id: staff.tenant_id?._id || staff.tenant_id || null });
    if (!hrmsUser) return { blocked: false, hrmsUser: null };

    const deviceName = deviceInfo?.deviceName || deviceInfo?.userAgent?.slice(0, 60) || "Unknown Device";

    if (!hrmsUser.registeredDeviceId && !hrmsUser.requireDeviceApproval) {
      // Genuine first login (no device ever set) — register automatically
      await HrmsUser.findByIdAndUpdate(hrmsUser._id, {
        registeredDeviceId: deviceId,
        registeredDeviceName: deviceName,
      });
      return { blocked: false, hrmsUser };
    }

    if (hrmsUser.registeredDeviceId && hrmsUser.registeredDeviceId === deviceId) {
      if (!hrmsUser.registeredDeviceName) {
        await HrmsUser.findByIdAndUpdate(hrmsUser._id, { registeredDeviceName: deviceName });
      }
      return { blocked: false, hrmsUser };
    }

    // Different device — block login and create a pending approval request
    const existing = await DeviceApproval.findOne({
      userId: hrmsUser._id,
      requestedDeviceId: deviceId,
      status: "pending",
    });
    if (!existing) {
      await DeviceApproval.create({
        userId: hrmsUser._id,
        requestedDeviceId: deviceId,
        deviceInfo: { ...(deviceInfo || {}), deviceName },
        status: "pending",
      });
    }
    return { blocked: true, hrmsUser };
  } catch (err) {
    console.error("[auth] device approval check failed (login allowed):", err.message);
    return { blocked: false, hrmsUser: null };
  }
};

// The same email can belong to several Staff rows: leftovers of a company
// that was deleted, next to the person's account in a company that still
// exists. Login must use the account that is still usable, not whichever row
// Mongo returns first. Picks, among the rows that pass `accept`, one whose
// company still exists (super admins have none); the most recently used first.
const STAFF_LOGIN_POPULATE = { path: "tenant_id", populate: { path: "plan_id", select: "name price billing_cycle trial_days banner_warning_days module_access" } };
const findLoginStaff = async (email, accept) => {
  const rows = await Staff.find({ email }).populate("role").populate(STAFF_LOGIN_POPULATE).sort({ last_login: -1, createdAt: -1 });
  let fallback = null;
  for (const staff of rows) {
    if (!(await accept(staff))) continue;
    if (staff.is_superadmin || (await resolveTenant(staff))) return staff;
    fallback = fallback || staff; // company gone — only used when nothing better exists
  }
  return fallback;
};

const login = async (req, res) => {
  const { email, password, deviceId, deviceInfo, location } = req.body;

  try {
    // Staff.email is stored lowercase+trimmed (schema-level normalization) —
    // normalize the incoming value the same way so case/whitespace from the
    // browser (autocapitalize, autofill, stray spaces) can't cause a false
    // "Invalid email or password".
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const staff = await findLoginStaff(normalizedEmail, (s) => s.matchPassword(password));

    if (staff) {
      if (staff.active === false) {
        return res.status(401).json({ message: "Account is deactivated" });
      }

      const tenant = await resolveTenant(staff);
      
      // Safety net: block logins from orphaned users whose tenant was deleted
      // prior to the cascade deletion fix.
      if (!staff.is_superadmin && !tenant) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      if (await rejectIfTenantBlocked(res, tenant, { isSuperadmin: staff.is_superadmin })) return;

      if (!(await isAllowedOnRequestDomain(req, staff, tenant))) {
        return res.status(403).json({ message: DOMAIN_LOCK_MESSAGE });
      }

      // Runs before 2FA is even considered — an unrecognized device never
      // gets as far as receiving an OTP.
      const deviceResult = await checkDeviceApproval(staff, deviceId, deviceInfo);
      if (deviceResult.blocked) {
        return res.status(403).json({
          devicePending: true,
          message: "Login from a new device detected. Your request has been sent to the admin for approval.",
        });
      }

      // The tenant owner (info@trinetratechnoworld.com) is excluded — 2FA is
      // only for staff created under that tenant, not the admin account
      // used to identify it.
      if (await isPilotTenant(tenant) && !isTrinetraPilotUser(staff)) {
        // Generate 6 digit code
        const code = crypto.randomInt(100000, 1000000).toString();
        staff.two_factor_auth_code = code;
        staff.two_factor_auth_code_requested = Date.now();
        staff.two_factor_auth_attempts = 0;
        await staff.save();

        // Local/dev visibility when SMTP isn't configured — never in production logs.
        if (process.env.NODE_ENV !== "production") console.log(`2FA Code for ${staff.email}: ${code}`);

        try {
          await EmailService.sendOtpCode(staff.email, code, tenant?._id);
        } catch (emailError) {
          console.error("[2FA] Failed to send OTP email:", emailError.message);
          return res.status(500).json({
            message: "Unable to send verification code. Please contact your administrator.",
          });
        }

        return res.json({
          two_factor_auth_enabled: true,
          message: "A verification code has been sent to your email",
          email: staff.email,
        });
      }

      staff.last_login = Date.now();
      await staff.save();
      logLogin(staff);

      // Session Logs (HRMS > Session Logs page) previously only ever recorded
      // logins through the separate HRMS-native login endpoint — real staff
      // logging in here (the actual Setup > Staff / staff login page) never
      // showed up at all. Mirror the same write user_controller.js's login
      // already does. Non-fatal: never blocks a successful login.
      try {
        const hrmsUser = deviceResult.hrmsUser
          || (staff.hrms_user_id
            ? await HrmsUser.findById(staff.hrms_user_id)
            : await HrmsUser.findOne({ email: staff.email, tenant_id: staff.tenant_id?._id || staff.tenant_id || null }));
        if (hrmsUser) {
          const deviceName = deviceInfo?.deviceName || deviceInfo?.userAgent?.slice(0, 60) || req.headers["user-agent"]?.slice(0, 60) || "Unknown Device";
          const address = location?.lat && location?.lng ? await reverseGeocode(location.lat, location.lng) : null;
          await SessionLog.create({
            userId: hrmsUser._id,
            action: "login",
            date: getISTDate(),
            time: getISTTime(),
            deviceId: deviceId || "Web",
            deviceName,
            ipAddress: getClientIp(req),
            userAgent: req.headers["user-agent"] || "",
            latitude: location?.lat ?? null,
            longitude: location?.lng ?? null,
            address,
          });
        }
      } catch (logErr) {
        console.error("[auth] Failed to write session log:", logErr.message);
      }

      const permissions = mergePermissions(staff);
      const token = generateToken(staff._id, "staff");
      const refreshToken = generateRefreshToken(staff._id, "staff");
      setTokenCookie(res, token);

      res.json({
        token,
        refreshToken,
        user: {
          _id: staff._id,
          firstname: staff.firstname,
          lastname: staff.lastname,
          email: staff.email,
          phonenumber: staff.phonenumber,
          admin: staff.admin,
          is_superadmin: staff.is_superadmin,
          is_hrms_staff: staff.is_hrms_staff,
          role: staff.role,
          tenant,
          notification_sound: staff.notification_sound,
        },
        permissions,
        plan_modules: tenant?.plan_id?.module_access || null,
      });
    } else {
      res.status(401).json({ message: "Invalid email or password" });
    }
  } catch (error) {
    console.error("[auth] login failed:", error);
    res.status(500).json({ message: error.message });
  }
};

const MAX_2FA_ATTEMPTS = 5;
const TWO_FA_TTL_MS = 10 * 60 * 1000;

// Constant-time compare of two 6-digit codes.
const codesMatch = (expected, given) => {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const verify2FA = async (req, res) => {
  const { email, code } = req.body;

  try {
    // A missing/blank code must never match an account that has no pending
    // code (both would be undefined) — require exactly 6 digits up front.
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      return res.status(401).json({ message: "Invalid 2FA code" });
    }
    const givenCode = code.trim();

    const normalizedEmail = String(email || "").trim().toLowerCase();
    // The account that was sent a code (same email-reuse rule as login).
    const staff = await findLoginStaff(normalizedEmail, async (s) => !!s.two_factor_auth_code);

    // Only an account that was actually sent a code (by a successful password
    // login) can complete 2FA.
    const requestedAt = staff?.two_factor_auth_code_requested ? new Date(staff.two_factor_auth_code_requested).getTime() : NaN;
    if (!staff || !staff.two_factor_auth_code || !Number.isFinite(requestedAt)) {
      return res.status(401).json({ message: "Invalid 2FA code" });
    }

    if (staff.active === false) {
      return res.status(401).json({ message: "Account is deactivated" });
    }

    if (Date.now() - requestedAt > TWO_FA_TTL_MS) {
      staff.two_factor_auth_code = undefined;
      staff.two_factor_auth_code_requested = undefined;
      staff.two_factor_auth_attempts = 0;
      await staff.save();
      return res.status(401).json({ message: "2FA code expired" });
    }

    if (!codesMatch(staff.two_factor_auth_code, givenCode)) {
      staff.two_factor_auth_attempts = (staff.two_factor_auth_attempts || 0) + 1;
      if (staff.two_factor_auth_attempts >= MAX_2FA_ATTEMPTS) {
        // Too many wrong codes — discard it; the user has to log in again for a new one.
        staff.two_factor_auth_code = undefined;
        staff.two_factor_auth_code_requested = undefined;
        staff.two_factor_auth_attempts = 0;
        await staff.save();
        return res.status(401).json({ message: "Too many wrong codes. Please log in again." });
      }
      await staff.save();
      return res.status(401).json({ message: "Invalid 2FA code" });
    }

    {

      const tenant = await resolveTenant(staff);

      if (!staff.is_superadmin && !tenant) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      if (await rejectIfTenantBlocked(res, tenant, { isSuperadmin: staff.is_superadmin })) return;

      if (!(await isAllowedOnRequestDomain(req, staff, tenant))) {
        return res.status(403).json({ message: DOMAIN_LOCK_MESSAGE });
      }

      // Clear code (single use)
      staff.two_factor_auth_code = undefined;
      staff.two_factor_auth_code_requested = undefined;
      staff.two_factor_auth_attempts = 0;
      staff.last_login = Date.now();
      await staff.save();
      logLogin(staff);

      const permissions = mergePermissions(staff);
      const token = generateToken(staff._id, "staff");
      const refreshToken = generateRefreshToken(staff._id, "staff");
      setTokenCookie(res, token);

      res.json({
        token,
        refreshToken,
        user: {
          _id: staff._id,
          firstname: staff.firstname,
          lastname: staff.lastname,
          email: staff.email,
          phonenumber: staff.phonenumber,
          admin: staff.admin,
          is_superadmin: staff.is_superadmin,
          is_hrms_staff: staff.is_hrms_staff,
          role: staff.role,
          tenant,
          notification_sound: staff.notification_sound,
        },
        permissions,
        plan_modules: tenant?.plan_id?.module_access || null,
      });
    }
  } catch (error) {
    console.error("[auth] verify2FA failed:", error);
    res.status(500).json({ message: error.message });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await req.user;
    if (user) {
      // If staff, populate role and merge permissions
      if (req.userRole === "staff") {
        const staff = await Staff.findById(user._id)
          .populate("role")
          .populate({ path: "tenant_id", populate: { path: "plan_id", select: "name price billing_cycle trial_days banner_warning_days module_access" } });
        const permissions = mergePermissions(staff);
        const tenant = await resolveTenant(staff);
        return res.json({
          user: {
            _id: staff._id,
            firstname: staff.firstname,
            lastname: staff.lastname,
            email: staff.email,
            phonenumber: staff.phonenumber,
            admin: staff.admin,
            is_superadmin: staff.is_superadmin,
          is_hrms_staff: staff.is_hrms_staff,
            role: staff.role,
            tenant,
            notification_sound: staff.notification_sound,
          },
          permissions,
          plan_modules: tenant?.plan_id?.module_access || null,
        });
      }
      res.json({ user });
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    console.error("[auth] getMe failed:", error);
    res.status(500).json({ message: error.message });
  }
};

const logout = (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  res.clearCookie("token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  });
  res.json({ message: "Logged out successfully" });
};

// Exchange a valid refresh token for a fresh access token (and rotate the
// refresh token). The frontend calls this on a 401 / near-expiry so users stay
// signed in for up to 30 days of activity instead of being cut off at 10h.
const refresh = async (req, res) => {
  try {
    const incoming = req.body?.refreshToken;
    if (!incoming) {
      return res.status(401).json({ code: "NO_REFRESH_TOKEN", message: "No refresh token provided" });
    }

    let decoded;
    try {
      decoded = jwt.verify(incoming, REFRESH_SECRET);
    } catch (err) {
      const code = err.name === "TokenExpiredError" ? "REFRESH_EXPIRED" : "REFRESH_INVALID";
      return res.status(401).json({ code, message: "Session expired, please log in again" });
    }

    if (decoded.type !== "refresh" || decoded.role !== "staff") {
      return res.status(401).json({ code: "REFRESH_INVALID", message: "Invalid refresh token" });
    }

    const staff = await Staff.findById(decoded.id).select("active tenant_id is_superadmin");
    if (!staff || staff.active === false) {
      return res.status(401).json({ code: "ACCOUNT_INACTIVE", message: "Account not active" });
    }
    if (await rejectIfTenantBlocked(res, staff.tenant_id, { isSuperadmin: staff.is_superadmin })) return;

    const token = generateToken(staff._id, "staff");
    const refreshToken = generateRefreshToken(staff._id, "staff");
    setTokenCookie(res, token);
    res.json({ token, refreshToken });
  } catch (err) {
    console.error("[auth] refresh failed:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { login, verify2FA, getMe, logout, refresh };
