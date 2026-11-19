const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("../models/user_model");
const { rejectIfTenantBlocked } = require("../../utils/tenantAccess");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Role = require("../models/role_model");
const Store = require("../models/store_model");
const Department = require("../models/department_model");
const Designation = require("../models/designation_model");
const SalaryStructure = require("../models/salary_structure_model");
const { salaryStructureFromConfig } = require("../utils/salaryStructureFromConfig");
const { scopedUserFilter, isTenantAdmin, getBranchScope } = require("../utils/branchScope");
const { loadRole } = require("../middleware/authorize");
const { checkNumber, checkEmail, checkPan, checkAadhaar, checkIfsc } = require("../utils/fieldRules");

// Salary, bank and ID-document fields are only for managers (tenant admin,
// branch supervisor, or an HRMS role with the Staff Directory permission) and
// for the employee themself — other staff get colleagues without them.
const STAFF_PRIVATE_FIELDS = "-password -salaryAmount -salaryStructureId -salaryManagedBy -bankInfo -legalDocuments -fcmToken -registeredDeviceId";
// Staff form fields the database would otherwise accept or turn into a 500:
// blank name, malformed email, negative / non-numeric salary figures.
const SALARY_PARTS = ["basic", "hra", "da", "conveyance", "medicalAllowance", "specialAllowance", "pf", "esic", "professionalTax"];
function staffFieldError(data, { isCreate }) {
  if ((isCreate || data.name !== undefined) && !String(data.name || "").trim()) return "Name is required";
  const emailError = checkEmail("Email", data.email);
  if (emailError) return emailError;
  const salaryError = checkNumber("Base salary", data.salaryAmount, { min: 0 });
  if (salaryError) return salaryError;

  // Validate Indian statutory tax/ID documents if provided
  const panError = checkPan("PAN number", data.legalDocuments?.panNumber);
  if (panError) return panError;
  const aadhaarError = checkAadhaar("Aadhaar number", data.legalDocuments?.aadhaarNumber);
  if (aadhaarError) return aadhaarError;

  // Validate Banking details if provided
  const ifscError = checkIfsc("IFSC code", data.bankInfo?.ifscCode);
  if (ifscError) return ifscError;
  if (data.bankInfo?.accountNumber) {
    const acc = String(data.bankInfo.accountNumber).trim();
    if (!/^\d{9,18}$/.test(acc)) return "Account number must be 9 to 18 digits";
  }

  const config = data.salaryConfig;
  if (config && typeof config === "object") {
    for (const part of SALARY_PARTS) {
      const err = checkNumber(`Salary ${part}`, config[part]?.value, { min: 0 });
      if (err) return err;
    }
  }
  return null;
}

async function canSeeStaffDetails(req) {
  if (await isTenantAdmin(req)) return true;
  if (await getBranchScope(req)) return true;
  const u = await loadRole(req);
  const mine = u?.permissions || [];
  return mine.includes("*") || ["manage_users", "view_staff"].some((p) => mine.includes(p));
}
const DeviceApproval = require("../models/device_approval_model");
const SessionLog = require("../models/session_log_model");
const { getISTDate, getISTTime } = require("../utils/timeUtils");
const { reverseGeocode } = require("../utils/geocode");
const { checkAccount, rejectAccountConflict, normalizePhone } = require("../../utils/accountUniqueness");
const { rejectIfStaffLimit } = require("../../utils/planLimits");
// CRM Staff login (../../models/Staff) — HRMS Staff Directory employees also
// get a linked CRM Staff account so they can log in via the normal /staff
// login instead of a separate HRMS-only login.
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");

const getClientIp = (req) => {
  let ip = req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.ip || "127.0.0.1";
  if (ip.includes(",")) {
    ip = ip.split(",")[0].trim();
  }
  if (ip === "::1" || ip === "::ffff:127.0.0.1") {
    ip = "127.0.0.1";
  }
  if (ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }
  return ip;
};

// Helper to reconstruct salaryConfig from populated salaryStructureId
const mapSalaryStructureToConfig = (user) => {
  if (!user) return user;

  const userObj = typeof user.toObject === 'function' ? user.toObject() : user;

  // Set default structure so all properties exist
  userObj.salaryConfig = {
    salaryTemplateId: "",
    tdsOnProfession: false,
    basic: { value: 0, type: "amount", isIncluded: false },
    hra: { value: 0, type: "amount", isIncluded: false },
    da: { value: 0, type: "amount", isIncluded: false },
    conveyanceAllowance: { value: 0, type: "amount", isIncluded: false },
    pf: { value: 0, type: "amount", isIncluded: false, mode: "per_day" },
    esic: { value: 0, type: "amount", isIncluded: false },
    epf: { value: 0, type: "amount", isIncluded: false },
    retention: { value: 0, type: "amount", isIncluded: false },
    professionalTax: { value: 0, type: "amount", isIncluded: false },
    adminCharge: { value: 0, type: "amount", isIncluded: false },
    bonus: { value: 0, type: "amount", isIncluded: false },
  };

  if (userObj.salaryStructureId && typeof userObj.salaryStructureId === 'object' && userObj.salaryStructureId.name !== undefined) {
    const struct = userObj.salaryStructureId;

    const pfDeduction = Array.isArray(struct.standardDeductions)
      ? struct.standardDeductions.find(d => d.name === "PF (Employee)")
      : null;
    const esicDeduction = Array.isArray(struct.standardDeductions)
      ? struct.standardDeductions.find(d => d.name === "ESIC")
      : null;

    userObj.salaryConfig = {
      salaryTemplateId: struct._id ? struct._id.toString() : "",
      tdsOnProfession: false,
      basic: {
        value: struct.basic || 0,
        type: "amount",
        isIncluded: struct.basic > 0
      },
      hra: {
        value: struct.hra || 0,
        type: "amount",
        isIncluded: struct.hra > 0
      },
      da: { value: 0, type: "amount", isIncluded: false },
      conveyanceAllowance: {
        value: struct.conveyance || 0,
        type: "amount",
        isIncluded: struct.conveyance > 0
      },
      pf: {
        value: pfDeduction ? pfDeduction.amount || 0 : 0,
        type: "amount",
        isIncluded: struct.pfApplicable || false,
        mode: struct.pfMode || "per_day",
        rate: struct.pfRate ?? 12
      },
      esic: {
        value: esicDeduction ? esicDeduction.amount || 0 : 0,
        type: "amount",
        isIncluded: struct.esicApplicable || false
      },
      epf: { value: 0, type: "amount", isIncluded: false },
      retention: { value: 0, type: "amount", isIncluded: false },
      professionalTax: {
        value: struct.professionalTax || 0,
        type: "amount",
        isIncluded: struct.professionalTax > 0
      },
      adminCharge: { value: 0, type: "amount", isIncluded: false },
      bonus: { value: 0, type: "amount", isIncluded: false },
    };
  }

  return userObj;
};

// Exported so staff_controller.js's getStaffById can show the same reconstructed
// Basic/HRA/PF/ESIC on Setup > Staff that this file's own getUserById shows on
// HRMS > Staff Directory — both edit the same underlying SalaryStructure.
exports.mapSalaryStructureToConfig = mapSalaryStructureToConfig;

// Helper to expand dot notation keys into nested objects
const { expandDotNotation } = require("../utils/expandDotNotation");
const { toPublicUploadPath } = require("../utils/uploadPath");
const { applyManagingBranch, branchIdForManagingCompany } = require("../utils/branchManagingCompany");

// Setup > Staff (CRM) profile fields shown on the HRMS form's CRM Info tab.
// They're stored on the linked Staff record only — see updateUser/getUserById.
const CRM_PROFILE_FIELDS = ["skype", "facebook", "linkedin", "default_language", "direction", "email_signature", "departments"];

exports.login = async (req, res) => {
  try {
    const { email, password, deviceId, deviceInfo, location } = req.body;

    // Emails are stored lowercase+trimmed (user_model.js), so match the typed
    // value the same way (autocapitalize / stray spaces from mobile keyboards).
    // The same email can have several profiles (leftovers of a deleted
    // company next to the live one): use a profile whose password matches,
    // preferring one whose company still exists and that is active.
    const candidates = await User.find({ email: String(email || "").trim().toLowerCase() })
      .populate("role", "role label permissions")
      .populate("salaryStructureId")
      .sort({ updatedAt: -1 });

    if (!candidates.length) {
      return res.status(400).json({ message: "No account found with this email address." });
    }

    const rank = async (u) => {
      const companyOk = !u.tenant_id || !!(await Tenant.exists({ _id: u.tenant_id }));
      return (companyOk ? 2 : 0) + (u.isActive !== false && u.status !== "inactive" ? 1 : 0);
    };
    let user = null;
    let best = -1;
    for (const u of candidates) {
      if (!(await bcrypt.compare(password, u.password))) continue;
      const r = await rank(u);
      if (r > best) { user = u; best = r; }
    }

    if (!user) {
      return res.status(400).json({ message: "Incorrect password. Please try again." });
    }

    if (user.isActive === false || user.status === "inactive") {
      return res.status(401).json({ message: "Account not active" });
    }

    // Suspended company, or a leftover login of a deleted company.
    if (await rejectIfTenantBlocked(res, user.tenant_id)) return;

    // Device lock check — only enforced when a deviceId is provided
    const userUpdateFields = {};

    if (deviceId) {
      const roleKey = user.role?.role || "";
      const isSuperAdmin = /super_admin|owner/i.test(roleKey);

      if (!isSuperAdmin) {
        const deviceName = deviceInfo?.deviceName || deviceInfo?.userAgent?.slice(0, 60) || "Unknown Device";

        if (!user.registeredDeviceId && !user.requireDeviceApproval) {
          // Genuine first login (no device ever set) — register automatically
          userUpdateFields.registeredDeviceId = deviceId;
          userUpdateFields.registeredDeviceName = deviceName;
        } else if (user.registeredDeviceId && user.registeredDeviceId === deviceId) {
          // Same registered device — fill in name if it was never captured
          if (!user.registeredDeviceName) {
            userUpdateFields.registeredDeviceName = deviceName;
          }
        } else {
          
          // Different device — block login and create a pending approval request
          const existing = await DeviceApproval.findOne({
            userId: user._id,
            requestedDeviceId: deviceId,
            status: "pending",
          });
          if (!existing) {
            await DeviceApproval.create({
              userId: user._id,
              requestedDeviceId: deviceId,
              deviceInfo: { ...(deviceInfo || {}), deviceName },
              status: "pending",
            });
          }
          return res.status(403).json({
            devicePending: true,
            message: "Login from a new device detected. Your request has been sent to the admin for approval.",
          });
        }
      }
    }

    if (req.body.fcmToken) {
      userUpdateFields.fcmToken = req.body.fcmToken;
    }

    // Use findByIdAndUpdate to reliably save fields on a populated document
    if (Object.keys(userUpdateFields).length > 0) {
      await User.findByIdAndUpdate(user._id, { $set: userUpdateFields });
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "10h" },
    );

    // Create Session Log Entry for login
    try {
      const deviceName = deviceInfo?.deviceName || deviceInfo?.userAgent?.slice(0, 60) || req.headers["user-agent"]?.slice(0, 60) || "Unknown Device";
      const address = location?.lat && location?.lng ? await reverseGeocode(location.lat, location.lng) : null;
      await SessionLog.create({
        userId: user._id,
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
    } catch (logErr) {
      console.error("Failed to write login log:", logErr);
    }

    res.json({
      token,
      user: mapSalaryStructureToConfig(user),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Admin: list device approval requests (all statuses or filter by ?status=pending)
// DeviceApproval has no tenant_id of its own — scope it by first resolving which
// User._ids belong to the requester's tenant, same principle as every other
// tenant-scoped query in this file.
const tenantUserIdFilter = async (req) => {
  if (req.user?.is_superadmin) return null; // no filter — sees everything
  const tenantUsers = await User.find({ tenant_id: req.user?.tenant_id || null }).select("_id");
  return tenantUsers.map((u) => u._id);
};

exports.getDeviceApprovals = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.json({ data: [] });
    }
    const userIds = await tenantUserIdFilter(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (userIds) filter.userId = { $in: userIds };
    const requests = await DeviceApproval.find(filter)
      .populate("userId", "name email mobile registeredDeviceId registeredDeviceName")
      .sort({ createdAt: -1 });
    res.json({ data: requests });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Admin: approve a device request — updates user's registeredDeviceId immediately
exports.approveDeviceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.userId || req.user?._id;

    const request = await DeviceApproval.findById(id);
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (!req.user?.is_superadmin) {
      const owner = await User.findOne({ _id: request.userId, tenant_id: req.user?.tenant_id || null }).select("_id");
      if (!owner) return res.status(404).json({ message: "Request not found" });
    }

    // Mark approval record
    request.status = "approved";
    request.approvedBy = adminId;
    request.approvedAt = new Date();
    await request.save();

    // Immediately update user's registered device so the VERY NEXT login succeeds
    const deviceName = request.deviceInfo?.deviceName
      || request.deviceInfo?.userAgent?.slice(0, 60)
      || "Unknown Device";

    await User.findByIdAndUpdate(request.userId, {
      $set: {
        registeredDeviceId: request.requestedDeviceId,
        registeredDeviceName: deviceName,
        requireDeviceApproval: false,
      },
    });

    res.json({
      success: true,
      message: `Device approved. "${deviceName}" is now the registered device. User can log in immediately.`,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Admin: reject a device request
exports.rejectDeviceRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await DeviceApproval.findById(id);
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (!req.user?.is_superadmin) {
      const owner = await User.findOne({ _id: request.userId, tenant_id: req.user?.tenant_id || null }).select("_id");
      if (!owner) return res.status(404).json({ message: "Request not found" });
    }
    request.status = "rejected";
    await request.save();
    res.json({ success: true, message: "Device request rejected." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Admin: remove/revoke an already-approved device.
// If it is the user's CURRENTLY registered device, clear the registration so
// it can no longer log in (next login needs fresh approval). Removing an older,
// no-longer-registered device just tidies the list and never touches the
// device the user is currently locked to — this enforces "one device only".
exports.revokeDeviceApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await DeviceApproval.findById(id);
    if (!request) return res.status(404).json({ message: "Request not found" });
    if (!req.user?.is_superadmin) {
      const owner = await User.findOne({ _id: request.userId, tenant_id: req.user?.tenant_id || null }).select("_id");
      if (!owner) return res.status(404).json({ message: "Request not found" });
    }

    const user = await User.findById(request.userId).select(
      "registeredDeviceId registeredDeviceName"
    );

    let clearedActive = false;
    if (
      user &&
      user.registeredDeviceId &&
      user.registeredDeviceId === request.requestedDeviceId
    ) {
      await User.findByIdAndUpdate(request.userId, {
        $set: {
          registeredDeviceId: null,
          registeredDeviceName: null,
          requireDeviceApproval: true,
        },
      });
      clearedActive = true;
    }

    request.status = "revoked";
    await request.save();

    res.json({
      success: true,
      clearedActive,
      message: clearedActive
        ? "Device removed. This device can no longer log in until it is re-approved."
        : "Device entry removed.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.refreshToken = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    // If this is a CRM token (has id and role), verify the CRM Staff account
    if (decoded.id) {
      const Staff = require("../../models/Staff");
      const staff = await Staff.findById(decoded.id).select("active tenant_id is_superadmin");
      if (!staff || staff.active === false) {
        return res.status(401).json({ message: "CRM Account deactivated" });
      }
      if (await rejectIfTenantBlocked(res, staff.tenant_id, { isSuperadmin: staff.is_superadmin })) return;

      const newToken = jwt.sign(
        { id: decoded.id, role: decoded.role },
        process.env.JWT_SECRET,
        { expiresIn: "10h" }
      );
      return res.json({ token: newToken });
    }

    // If this is an HRMS-native token (has userId)
    if (decoded.userId) {
      const user = await User.findById(decoded.userId).select("isActive status tenant_id");
      if (!user || user.isActive === false || user.status === "inactive") {
        return res.status(401).json({ message: "Account not active" });
      }
      if (await rejectIfTenantBlocked(res, user.tenant_id)) return;

      const newToken = jwt.sign(
        { userId: user._id },
        process.env.JWT_SECRET,
        { expiresIn: "10h" }
      );
      return res.json({ token: newToken });
    }

    return res.status(401).json({ message: "Invalid token structure" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user?.userId || req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized: User ID missing" });
    }
    const user = await User.findByIdAndUpdate(
      userId,
      { fcmToken: fcmToken || "" },
      { returnDocument: "after" }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.status(200).json({ success: true, message: "FCM token updated successfully", fcmToken: user.fcmToken });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error updating FCM token", error: err.message });
  }
};

exports.createUser = async (req, res) => {
  try {
    const invalid = staffFieldError(expandDotNotation({ ...req.body }), { isCreate: true });
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const { email, mobile } = req.body;
    const newUserTenantId = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);
    // One email / one mobile = one account across every company; mobile is
    // required and exactly 10 digits (utils/accountUniqueness.js).
    const check = await checkAccount({
      kind: "user", email, phone: mobile, tenantId: newUserTenantId, requirePhone: true,
    });
    if (rejectAccountConflict(res, check)) return;
    req.body.email = check.email;
    req.body.mobile = check.phone;

    // Plan's Team Members limit: the new employee gets a staff login, unless
    // one with this email already exists in the company (it is linked instead).
    const hasStaffLogin = await Staff.exists({ email: check.email, tenant_id: newUserTenantId });
    if (!hasStaffLogin && (await rejectIfStaffLimit(req, res, newUserTenantId))) return;

    // Handle file uploads if present (multer.any() returns an array)
    const rawData = { ...req.body };

    if (req.files && Array.isArray(req.files)) {
      req.files.forEach(file => {
        if (file.fieldname === "pan") rawData["legalDocuments.panUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "aadhaar") rawData["legalDocuments.aadhaarUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "passportPhoto") rawData["legalDocuments.passportPhotoUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "avatar") rawData["avatar"] = toPublicUploadPath(file.path);
      });
    }

    const userData = expandDotNotation(rawData);
    if (userData.legalDocuments?.panNumber) {
      userData.legalDocuments.panNumber = String(userData.legalDocuments.panNumber).trim().toUpperCase();
    }
    if (userData.legalDocuments?.aadhaarNumber) {
      userData.legalDocuments.aadhaarNumber = String(userData.legalDocuments.aadhaarNumber).replace(/[\s-]/g, "");
    }
    if (userData.bankInfo?.ifscCode) {
      userData.bankInfo.ifscCode = String(userData.bankInfo.ifscCode).trim().toUpperCase();
    }

    // Intercept salaryConfig to save it in salarystructures
    if (userData.salaryConfig) {
      const config = userData.salaryConfig;

      const structureName = `${userData.name || "Employee"}'s Salary Structure (${Date.now()})`;
      const structureData = {
        name: structureName,
        ...salaryStructureFromConfig(config),
        conveyance: 0,
        medicalAllowance: 0,
        specialAllowance: 0,
        isActive: true
      };

      const salaryStructure = new SalaryStructure(structureData);
      await salaryStructure.save();

      userData.salaryStructureId = salaryStructure._id;
      delete userData.salaryConfig;
    }

    if (userData.salaryStructureId && typeof userData.salaryStructureId === 'string' && mongoose.Types.ObjectId.isValid(userData.salaryStructureId)) {
      userData.salaryStructureId = new mongoose.Types.ObjectId(userData.salaryStructureId);
    }

    // Capture the plaintext password now — the HRMS User's own pre-save hook
    // hashes `user.password` in place, so it won't be readable after .save().
    const plainPassword = userData.password;

    // Scope this new employee to the creator's tenant — same rule staff_controller.js
    // already applies when creating a Staff record.
    userData.tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    const user = new User(userData);
    try {
      await user.save();
    } catch (saveError) {
      if (userData.salaryStructureId) {
        await SalaryStructure.findByIdAndDelete(userData.salaryStructureId);
      }
      throw saveError;
    }

    // Link a CRM Staff login so this employee can sign in through the normal
    // staff login (same URL as Setup → Staff) instead of a separate HRMS
    // login. Restricted via is_hrms_staff — the sidebar shows them only
    // Dashboard + HRMS self-service (My Attendance/Leaves/Expenses).
    try {
      // Same company only — an unscoped lookup could link another company's login.
      const existingStaffLogin = await Staff.findOne({ email: user.email, tenant_id: user.tenant_id || null });
      if (existingStaffLogin) {
        if (!existingStaffLogin.hrms_user_id) {
          existingStaffLogin.hrms_user_id = user._id;
          await existingStaffLogin.save();
        }
        if (!user.staffId) {
          await User.findByIdAndUpdate(user._id, { staffId: existingStaffLogin._id });
        }
      } else {
        // A blank Password should never silently skip creating the mirrored
        // Staff login — same safety net as staff_controller.js's
        // linkHrmsProfile for the reverse direction.
        const passwordForStaff = plainPassword || crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
        const nameParts = (user.name || "Employee").trim().split(/\s+/);
        const newStaff = await Staff.create({
          firstname: nameParts[0] || "Employee",
          lastname: nameParts.slice(1).join(" ") || "User",
          email: user.email,
          password: passwordForStaff,
          phonenumber: user.mobile || "",
          admin: false,
          active: user.isActive !== false,
          is_hrms_staff: true,
          tenant_id: req.user?.tenant_id || req.user?.tenant?._id || null,
        });
        await User.findByIdAndUpdate(user._id, { staffId: newStaff._id });
      }
    } catch (linkErr) {
      console.error("Failed to link HRMS employee to a CRM Staff login:", linkErr.message);
    }

    // Auto-sync salesperson profile if applicable
    try {
      const { syncSalespersons } = require("./salesperson_controller");
      await syncSalespersons();
    } catch (e) {
      console.error("Auto-sync error during user creation:", e);
    }

    const populatedUser = await User.findById(user._id)
      .populate("role", "role label permissions")
      .populate("department", "name code")
      .populate("designation", "name level")
      .populate("salaryStructureId")
      .select("-password");
    res.status(201).json({ success: true, data: mapSalaryStructureToConfig(populatedUser) });
  } catch (err) {
    // Schema validation (e.g. a required field) is the user's input, not a server fault.
    res
      .status(err.name === "ValidationError" ? 400 : 500)
      .json({ message: err.name === "ValidationError" ? err.message : "Error creating user", error: err.message });
  }
};

// Note: `User.find(query)` here legitimately returns nothing for a tenant that hasn't
// onboarded any employees into HRMS yet. This model is intentionally separate from the
// main CRM's Staff collection (see the comment on the User schema in ../models/user_model.js)
// — it is not synced from Staff, so an empty result here is a data/onboarding state, not a
// bug in this query. Populate it via the "Add Employee" form or the bulk import endpoint
// (import_employees_controller.js), not by pulling from another module.
exports.getUsers = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({ success: true, count: 0, total: 0, page: 1, limit: 0, totalPages: 0, data: [] });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Scope to the requester's own tenant — see auth_middleware.js's `protect`, which
    // resolves req.user.tenant_id for both the CRM-staff-bridged and native HRMS login paths.
    const query = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id, ...(await scopedUserFilter(req)) };
    if (req.query.role) {
      const roleQuery = Array.isArray(req.query.role) ? req.query.role[0] : req.query.role;

      // If it looks like a Mongo ID, use it directly
      if (typeof roleQuery === 'string' && roleQuery.match(/^[0-9a-fA-F]{24}$/)) {
        query.role = roleQuery;
      } else if (typeof roleQuery === 'string') {
        // Otherwise, look up the role by its name string
        const roleDoc = await Role.findOne({ role: roleQuery.toLowerCase() });
        if (roleDoc) {
          query.role = roleDoc._id;
        } else {
          // If role not found, return empty data
          return res.status(200).json({
            success: true,
            count: 0,
            total: 0,
            data: [],
          });
        }
      }
    }
    if (req.query.isActive !== undefined) query.isActive = req.query.isActive;

    // Server-side search + branch filter. The Staff Directory used to filter
    // only the 25 rows of the current page, so searching "Anjali" missed every
    // Anjali on other pages.
    const extra = [];
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      extra.push({ $or: [{ name: rx }, { email: rx }, { mobile: rx }, { employeeCode: rx }] });
    }
    if (req.query.hrmsBranchId && mongoose.Types.ObjectId.isValid(req.query.hrmsBranchId)) {
      // $and keeps a branch supervisor's own branch scope (scopedUserFilter) intact.
      extra.push({ hrmsBranchId: new mongoose.Types.ObjectId(req.query.hrmsBranchId) });
    }
    if (extra.length) query.$and = [...(query.$and || []), ...extra];

    const fullDetails = await canSeeStaffDetails(req);
    let usersQuery = User.find(query)
      .skip(skip)
      .limit(limit)
      .populate("role", "role label permissions")
      .populate("department", "name code")
      .populate("designation", "name level")
      .select(fullDetails ? "-password" : STAFF_PRIVATE_FIELDS);
    if (fullDetails) usersQuery = usersQuery.populate("salaryStructureId");
    const users = await usersQuery
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(query);

    res.status(200).json({
      success: true,
      count: users.length,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
      data: users.map(mapSalaryStructureToConfig),
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching users", error: err.message });
  }
};

exports.getSalespersons = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }
    const tenantFilter = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id };
    const salespersons = await User.find({ ...tenantFilter, isSalesperson: true, isActive: true })
      .select("name mobile email")
      .sort({ name: 1 });

    res.status(200).json({
      success: true,
      count: salespersons.length,
      data: salespersons,
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching salespersons", error: err.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const rawData = { ...req.body };

    // Handle password update separately if provided. Captured before HRMS's
    // own hash overwrites it in place — the linked CRM Staff login (see
    // createUser's Staff.create below) needs the same plaintext to set its
    // own independent hash, or editing a password here silently leaves the
    // old CRM staff login password in place with no way to tell they've
    // diverged.
    const plainPassword = rawData.password || null;
    if (rawData.password) {
      rawData.password = await bcrypt.hash(rawData.password, 10);
    } else {
      delete rawData.password;
    }

    // Handle file uploads if present
    if (req.files) {
      // Normalize files to an array for consistent processing
      const filesArray = Array.isArray(req.files)
        ? req.files
        : Object.values(req.files).flat();

      filesArray.forEach(file => {
        if (file.fieldname === "pan") rawData["legalDocuments.panUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "aadhaar") rawData["legalDocuments.aadhaarUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "passportPhoto") rawData["legalDocuments.passportPhotoUrl"] = toPublicUploadPath(file.path);
        if (file.fieldname === "avatar") rawData["avatar"] = toPublicUploadPath(file.path);
      });
    }

    const updateData = expandDotNotation(rawData);
    const invalid = staffFieldError(updateData, { isCreate: false });
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    // Prevent updating immutable fields
    delete updateData.id;
    delete updateData._id;
    delete updateData.email;
    delete updateData.tenant_id; // never reassignable via this endpoint

    // Role is no longer editable from the Staff form (Employment Details) —
    // the field was removed from the UI, so ignore it here too if a stale
    // client or old cached form still submits one.
    delete updateData.role;

    // CRM-only fields from the HRMS form's CRM Info / Permissions tabs live on
    // the linked Setup > Staff record, not on User (strict mode would silently
    // drop them). Pull them out here and apply them to Staff after the User save.
    const crmUpdates = {};
    for (const key of CRM_PROFILE_FIELDS) {
      if (updateData[key] !== undefined) crmUpdates[key] = updateData[key];
      delete updateData[key];
    }
    const crmSecurityUpdates = {};
    for (const key of ["crmRole", "admin", "permissions", "permissionsCleared"]) {
      if (updateData[key] !== undefined) crmSecurityUpdates[key] = updateData[key];
      delete updateData[key];
    }
    // Role, admin rights and permissions are the CRM's access control — same
    // rule as Setup > Staff: only a tenant admin / superadmin may change them.
    // This route is otherwise open to any logged-in user who can edit the profile.
    const canChangeAccess = !!(req.user?.admin || req.user?.is_superadmin);

    // Some legacy staff records still carry a pre-migration plain-string value
    // in a field that's now an ObjectId ref (e.g. an old role/branch/department
    // key). Editing that record without touching the dropdown re-submits the
    // stale string and Mongoose throws a CastError, 400-ing the whole update.
    // Since the client can't fix data it doesn't know is broken, drop the
    // stale reference here instead of blocking the save.
    const OBJECT_ID_REF_FIELDS = ["hrmsBranchId", "department", "designation", "shiftId", "salaryTemplateId", "managingCompanyId"];
    for (const field of OBJECT_ID_REF_FIELDS) {
      const value = updateData[field];
      if (value != null && typeof value === "string" && !mongoose.Types.ObjectId.isValid(value)) {
        console.warn(`updateUser: dropping invalid legacy ${field} value "${value}" for user ${req.params.id}`);
        updateData[field] = null;
      }
    }

    // Fetch existing user to find their linked salary structure — scoped to the
    // requester's own tenant so one tenant can't update another tenant's employee by ID.
    const existingUserQuery = { _id: req.params.id };
    if (!req.user?.is_superadmin) existingUserQuery.tenant_id = req.user?.tenant_id || null;
    const existingUser = await User.findOne(existingUserQuery);
    if (!existingUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Re-activating an employee takes a seat in the plan's Team Members limit.
    const reactivating = existingUser.isActive === false && req.body.isActive !== undefined
      && req.body.isActive !== false && req.body.isActive !== "false";
    if (reactivating && (await rejectIfStaffLimit(req, res, existingUser.tenant_id))) return;

    // One mobile = one account across every company, exactly 10 digits
    // (utils/accountUniqueness.js). Only checked when the mobile is sent, so
    // side updates (status, salary...) never fail on an old profile without one.
    if (updateData.mobile !== undefined) {
      const sent = normalizePhone(updateData.mobile);
      const ownPhone = !sent.error && sent.phone && sent.phone === normalizePhone(existingUser.mobile).phone;
      if (!ownPhone) {
        const check = await checkAccount({
          kind: "user",
          phone: updateData.mobile,
          requirePhone: true,
          userId: existingUser._id,
          staffId: existingUser.staffId,
          tenantId: existingUser.tenant_id || null,
        });
        if (rejectAccountConflict(res, check)) return;
      }
      updateData.mobile = sent.phone;
    }

    // "Salary Managed By: Branch" — map the chosen HRMS branch to its
    // ManagingCompany, same as Setup > Staff (utils/branchManagingCompany.js).
    await applyManagingBranch(updateData, updateData, existingUser.tenant_id);
    delete updateData.managingBranchId;

    // Intercept salaryConfig to save/update in salarystructures
    if (updateData.salaryConfig) {
      const config = updateData.salaryConfig;
      let salaryStructure;

      if (existingUser.salaryStructureId && mongoose.Types.ObjectId.isValid(existingUser.salaryStructureId)) {
        // Update existing structure
        salaryStructure = await SalaryStructure.findById(existingUser.salaryStructureId);
      }

      const structureData = salaryStructureFromConfig(config);

      if (salaryStructure) {
        // Perform update
        Object.assign(salaryStructure, structureData);
        await salaryStructure.save();
      } else {
        // Create a new salary structure document
        const structureName = `${updateData.name || existingUser.name || "Employee"}'s Salary Structure (${Date.now()})`;
        salaryStructure = new SalaryStructure({
          name: structureName,
          ...structureData,
          conveyance: 0,
          medicalAllowance: 0,
          specialAllowance: 0,
          isActive: true
        });
        await salaryStructure.save();
      }

      updateData.salaryStructureId = salaryStructure._id;
      delete updateData.salaryConfig;
    }

    if (updateData.salaryStructureId && typeof updateData.salaryStructureId === 'string' && mongoose.Types.ObjectId.isValid(updateData.salaryStructureId)) {
      updateData.salaryStructureId = new mongoose.Types.ObjectId(updateData.salaryStructureId);
    }

    const user = await User.findByIdAndUpdate(req.params.id, updateData, {
      returnDocument: "after",
      runValidators: true,
    })
      .select("-password")
      .populate("role", "role label permissions")
      .populate("department", "name code")
      .populate("designation", "name level")
      .populate("salaryStructureId");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Keep the linked CRM Staff login in sync with this HRMS employee record
    // — previously only Password propagated here, leaving Name/Mobile/Active
    // edits on the HRMS side invisible on the Setup > Staff side. Employees
    // created before the auto-link existed (e.g. old bulk imports) have no
    // linked Staff account at all yet — create it here instead of silently
    // no-op'ing, same shape as createUser's Staff.create.
    const nameChanged = updateData.name !== undefined && updateData.name !== existingUser.name;
    const mobileChanged = updateData.mobile !== undefined && updateData.mobile !== existingUser.mobile;
    const activeChanged = updateData.isActive !== undefined && updateData.isActive !== existingUser.isActive;
    const hasCrmChanges = Object.keys(crmUpdates).length > 0 || (canChangeAccess && Object.keys(crmSecurityUpdates).length > 0);
    if (plainPassword || nameChanged || mobileChanged || activeChanged || hasCrmChanges) {
      try {
        const linkedStaff = user.staffId
          ? await Staff.findById(user.staffId)
          : await Staff.findOne({ email: existingUser.email, tenant_id: existingUser.tenant_id || null });
        if (linkedStaff) {
          if (plainPassword) linkedStaff.password = plainPassword;
          if (nameChanged) {
            const nameParts = String(updateData.name || "").trim().split(/\s+/);
            linkedStaff.firstname = nameParts[0] || linkedStaff.firstname;
            // A one-word name clears the surname instead of keeping the old one.
            linkedStaff.lastname = nameParts.slice(1).join(" ");
          }
          if (mobileChanged) linkedStaff.phonenumber = updateData.mobile || "";
          if (activeChanged) linkedStaff.active = updateData.isActive !== false;
          for (const [key, value] of Object.entries(crmUpdates)) {
            linkedStaff[key] = key === "departments"
              ? (Array.isArray(value) ? value : [value]).filter(Boolean)
              : (value ?? "");
          }
          if (canChangeAccess) {
            if (crmSecurityUpdates.crmRole !== undefined) linkedStaff.role = crmSecurityUpdates.crmRole || null;
            if (crmSecurityUpdates.admin !== undefined) linkedStaff.admin = crmSecurityUpdates.admin === true;
            if (crmSecurityUpdates.permissions !== undefined) linkedStaff.permissions = crmSecurityUpdates.permissions || {};
            else if (crmSecurityUpdates.permissionsCleared) linkedStaff.permissions = {};
          }
          await linkedStaff.save();
          if (!user.staffId) await User.findByIdAndUpdate(user._id, { staffId: linkedStaff._id });
        } else {
          const nameParts = (existingUser.name || "Employee").trim().split(/\s+/);
          const passwordForStaff = plainPassword || crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
          const newStaff = await Staff.create({
            firstname: nameParts[0] || "Employee",
            lastname: nameParts.slice(1).join(" ") || "User",
            email: existingUser.email,
            password: passwordForStaff,
            phonenumber: existingUser.mobile || "",
            admin: false,
            active: true,
            is_hrms_staff: true,
            tenant_id: req.user?.tenant_id || req.user?.tenant?._id || null,
          });
          await User.findByIdAndUpdate(user._id, { staffId: newStaff._id });
        }
      } catch (syncErr) {
        console.error("Failed to sync linked CRM Staff login:", syncErr.message);
      }
    }

    // Auto-sync salesperson profile if applicable
    try {
      const { syncSalespersons } = require("./salesperson_controller");
      await syncSalespersons();
    } catch (e) {
      console.error("Auto-sync error during user update:", e);
    }

    res.status(200).json({ success: true, data: mapSalaryStructureToConfig(user) });
  } catch (err) {
    console.error("Update User Error:", err);
    try {
      require("fs").appendFileSync("last_update_error.txt", new Date().toISOString() + " - " + err.name + " - " + err.message + "\n" + (err.errors ? JSON.stringify(err.errors) : "") + "\n\n");
    } catch(e) {}
    if (err.name === "CastError") {
      return res.status(400).json({
        message: `Invalid ID format for field '${err.path}'`,
        error: err.message
      });
    }

    if (err.name === "ValidationError") {
      const fieldErrors = Object.values(err.errors).map(e => e.message).join(", ");
      return res.status(400).json({
        message: `Validation Error: ${fieldErrors}`,
        error: err.message,
        details: err.errors
      });
    }

    res.status(500).json({
      message: "Error updating user",
      error: err.message
    });
  }
};

// PATCH /users/bulk-update  { userIds: [...], updates: { hrmsBranchId?, shiftId?, department?,
//   designation?, payType?, isActive?, pf?: { isIncluded?, mode?, value? } } }
// Bulk edit from the Staff Directory. Only fields present in `updates` change;
// role stays editable only from Setup > Staff (same rule as updateUser).
const BULK_REF_FIELDS = ["hrmsBranchId", "shiftId", "department", "designation"];
exports.bulkUpdateUsers = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const userIds = (Array.isArray(req.body.userIds) ? req.body.userIds : [])
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const updates = req.body.updates || {};
    if (userIds.length === 0) {
      return res.status(400).json({ success: false, message: "Select at least one employee" });
    }

    const set = {};
    for (const field of BULK_REF_FIELDS) {
      if (updates[field] === undefined) continue;
      // "" / null = clear the field (e.g. "No shift")
      if (updates[field] === null || updates[field] === "") set[field] = null;
      else if (mongoose.Types.ObjectId.isValid(updates[field])) set[field] = updates[field];
      else return res.status(400).json({ success: false, message: `Invalid ${field}` });
    }
    if (updates.payType !== undefined) set.payType = updates.payType;
    if (updates.isActive !== undefined) set.isActive = !!updates.isActive;

    const pf = updates.pf && typeof updates.pf === "object" ? updates.pf : null;
    if (Object.keys(set).length === 0 && !pf) {
      return res.status(400).json({ success: false, message: "Choose at least one field to change" });
    }

    const targets = await User.find({ _id: { $in: userIds }, ...tenantFilter }).select("_id name staffId salaryStructureId");
    const targetIds = targets.map((u) => u._id);

    // Bulk re-activation takes one seat per inactive linked staff login.
    if (set.isActive === true) {
      const staffIds = targets.map((u) => u.staffId).filter(Boolean);
      const adding = staffIds.length ? await Staff.countDocuments({ _id: { $in: staffIds }, active: false }) : 0;
      if (adding && (await rejectIfStaffLimit(req, res, tenantFilter.tenant_id, adding))) return;
    }

    let modified = 0;
    if (Object.keys(set).length) {
      const result = await User.updateMany({ _id: { $in: targetIds } }, { $set: set }, { runValidators: true });
      modified = result.modifiedCount;

      // Keep the linked CRM Staff login's active flag in sync (same as updateUser).
      if (set.isActive !== undefined) {
        const staffIds = targets.map((u) => u.staffId).filter(Boolean);
        if (staffIds.length) await Staff.updateMany({ _id: { $in: staffIds } }, { $set: { active: set.isActive } });
      }
    }

    // PF settings live on each employee's own SalaryStructure — update only the
    // PF fields given, creating a structure for employees that don't have one yet.
    if (pf) {
      const pfSet = {};
      if (pf.isIncluded !== undefined) pfSet.pfApplicable = !!pf.isIncluded;
      if (pf.mode !== undefined) pfSet.pfMode = salaryStructureFromConfig({ pf: { mode: pf.mode } }).pfMode;
      for (const u of targets) {
        let structure = u.salaryStructureId ? await SalaryStructure.findById(u.salaryStructureId) : null;
        if (!structure) {
          structure = new SalaryStructure({
            name: `${u.name || "Employee"}'s Salary Structure (${Date.now()})`,
            basic: 0, hra: 0, conveyance: 0, medicalAllowance: 0, specialAllowance: 0,
            standardDeductions: [{ name: "PF (Employee)", amount: 0 }, { name: "ESIC", amount: 0 }],
            isActive: true,
          });
        }
        Object.assign(structure, pfSet);
        if (pf.value !== undefined && pf.value !== "") {
          const deductions = (structure.standardDeductions || []).filter((d) => d.name !== "PF (Employee)");
          deductions.unshift({ name: "PF (Employee)", amount: Number(pf.value) || 0 });
          structure.standardDeductions = deductions;
        }
        await structure.save();
        if (!u.salaryStructureId) await User.updateOne({ _id: u._id }, { $set: { salaryStructureId: structure._id } });
      }
      modified = Math.max(modified, targets.length);
    }

    res.status(200).json({
      success: true,
      message: `${targets.length} employee(s) updated`,
      data: { matched: targets.length, modified },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error updating employees", error: err.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id || null;
    const user = await User.findOneAndDelete(query);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Mirror staff_controller.js's deleteStaff: deactivate (never hard-delete)
    // the linked CRM Staff login instead of leaving it silently untouched —
    // without this, deleting someone from HRMS > Users left their CRM login
    // fully active with no visible link between the two records.
    try {
      const linkedStaff = user.staffId
        ? await Staff.findById(user.staffId)
        : await Staff.findOne({ email: user.email });
      if (linkedStaff && linkedStaff.active !== false) {
        linkedStaff.active = false;
        await linkedStaff.save();
      }
    } catch (deactivateErr) {
      console.error("Failed to deactivate linked CRM Staff login:", deactivateErr.message);
    }

    res
      .status(200)
      .json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error deleting user", error: err.message });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id || null;
    const isSelf = String(req.params.id) === String(req.user?.userId);
    if (!isSelf && !(await canSeeStaffDetails(req))) {
      return res.status(403).json({ success: false, message: "You can only view your own profile" });
    }
    const user = await User.findOne(query)
      .populate("role", "role label permissions")
      .populate("department", "name code")
      .populate("designation", "name level")
      .populate("salaryStructureId")
      .select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userObj = mapSalaryStructureToConfig(user);
    userObj.managingBranchId = await branchIdForManagingCompany(user.managingCompanyId);

    // Merge in the linked Setup > Staff record's CRM-only fields — mirrors
    // staff_controller.js's getStaffById merging HRMS fields the other way.
    // updateUser writes them back to Staff (role/admin/permissions only for a
    // tenant admin), so both edit screens show and save the same values.
    try {
      const crmSelect = ["admin", "permissions", "role", ...CRM_PROFILE_FIELDS].join(" ");
      const linkedStaff = user.staffId
        ? await Staff.findById(user.staffId).select(crmSelect)
        : await Staff.findOne({ email: user.email, tenant_id: user.tenant_id || null }).select(crmSelect);
      if (linkedStaff) {
        let permissions = linkedStaff.permissions;
        if (permissions instanceof Map) {
          const plain = {};
          permissions.forEach((value, key) => {
            plain[key] = value instanceof Map ? Object.fromEntries(value) : value;
          });
          permissions = plain;
        }
        userObj.crmInfo = {
          // Setup > Staff id — customer assignment (Assigned Customers tab)
          // is keyed by Staff, not by this HRMS User id.
          staffId: String(linkedStaff._id),
          role: linkedStaff.role ? String(linkedStaff.role) : "",
          admin: !!linkedStaff.admin,
          permissions: permissions || {},
          skype: linkedStaff.skype || "",
          facebook: linkedStaff.facebook || "",
          linkedin: linkedStaff.linkedin || "",
          default_language: linkedStaff.default_language || "",
          direction: linkedStaff.direction || "",
          email_signature: linkedStaff.email_signature || "",
          departments: (linkedStaff.departments || []).map(String),
        };
      }
    } catch (mergeErr) {
      console.error("Failed to load linked CRM Staff profile:", mergeErr.message);
    }

    res.status(200).json({ success: true, data: userObj });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching user", error: err.message });
  }
};

exports.logout = async (req, res) => {
  try {
    if (req.user) {
      const uId = req.user.userId || req.user._id || req.user.id;
      if (uId) {
        await User.findByIdAndUpdate(uId, { fcmToken: "" });
        
        // Log Session Logout
        try {
          const location = req.body?.location;
          const address = location?.lat && location?.lng ? await reverseGeocode(location.lat, location.lng) : null;
          await SessionLog.create({
            userId: uId,
            action: "logout",
            date: getISTDate(),
            time: getISTTime(),
            deviceId: "Web",
            deviceName: req.headers["user-agent"]?.slice(0, 60) || "Unknown Device",
            ipAddress: getClientIp(req),
            userAgent: req.headers["user-agent"] || "",
            latitude: location?.lat ?? null,
            longitude: location?.lng ?? null,
            address,
          });
        } catch (logErr) {
          console.error("Failed to write logout log:", logErr);
        }
        
      }
    }
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error during logout", error: err.message });
  }
};

exports.getSessionLogs = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({ success: true, data: [], total: 0 });
    }

    const { date, userId, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;

    const tenantScope = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);

    const filter = {};
    if (date) filter.date = date;

    // Session logs have no tenant_id of their own — always resolve via matching
    // User ids scoped to the requester's tenant, whether a specific userId, a
    // name/email search, or neither was given, so a userId from another tenant
    // can't be requested directly either.
    const userQuery = { tenant_id: tenantScope };
    if (userId) userQuery._id = userId;
    if (search && search.trim()) {
      userQuery.$or = [
        { name: { $regex: search.trim(), $options: "i" } },
        { email: { $regex: search.trim(), $options: "i" } },
      ];
    }
    if (userId || search?.trim() || !req.user?.is_superadmin) {
      const matchingUsers = await User.find(userQuery).select("_id");
      filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const [logs, total] = await Promise.all([
      SessionLog.find(filter)
        .populate("userId", "name email mobile avatar role hrmsBranchId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      SessionLog.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching session logs", error: err.message });
  }
};
