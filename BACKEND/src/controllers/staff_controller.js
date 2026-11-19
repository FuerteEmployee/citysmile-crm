const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const Staff = require("../models/Staff");
// Required directly (not just relied on via role_routes/role_controller) so
// Staff.findOne(...).populate("role") always has the Role schema registered,
// regardless of which routes have been loaded first.
const Role = require("../models/Role");
const User = require("../hrms/models/user_model");
const HRMSDepartment = require("../hrms/models/department_model");
const Designation = require("../hrms/models/designation_model");
const HRMSBranch = require("../hrms/models/hrms_branch_model");
const SalaryStructure = require("../hrms/models/salary_structure_model");
const { salaryStructureFromConfig } = require("../hrms/utils/salaryStructureFromConfig");
const { mapSalaryStructureToConfig } = require("../hrms/controllers/user_controller");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");
const { checkStaffLimit, rejectIfStaffLimit } = require("../utils/planLimits");
const { expandDotNotation } = require("../hrms/utils/expandDotNotation");
const { toPublicUploadPath } = require("../hrms/utils/uploadPath");
const { applyManagingBranch, branchIdForManagingCompany } = require("../hrms/utils/branchManagingCompany");
const {
  checkAccount,
  rejectAccountConflict,
  normalizeEmail,
  normalizePhone,
  EMAIL_TAKEN_MESSAGE,
  PHONE_TAKEN_MESSAGE,
} = require("../utils/accountUniqueness");
const {
  checkNumber, checkEmail, checkPhone, checkPan, checkAadhaar, checkIfsc, firstError, isBlank,
} = require("../hrms/utils/fieldRules");
const { statusForError } = require("../utils/requestSafety");
const Tenant = require("../models/Tenant");

// Used only when Setup > Staff's Password field is left blank at creation —
// without this, linkHrmsProfile used to silently skip creating the HRMS
// profile entirely (staff visible in Setup > Staff, invisible in HRMS >
// Staff Directory, with no error shown anywhere).
const generateTempPassword = () =>
  crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);

// HRMS-domain fields Setup > Staff's form also collects (Employment Details, Salary
// & Banking, Legal Documents, plus the extra Identity & Personal fields) — these live
// on the HRMS User profile, not on Staff itself, so they're extracted from req.body
// here and forwarded into linkHrmsProfile/syncHrmsProfile rather than the Staff schema.
const HRMS_PROFILE_FIELDS = [
  "gender", "dob", "bloodGroup", "education", "totalExperience", "residentialPhone",
  "emergencyContact", "address",
  "hrmsBranchId", "department", "designation", "shiftId", "joiningDate",
  "employmentType", "attendanceRequired", "isSalesperson", "weeklyHolidays",
  "bankInfo", "payType", "salaryAmount", "salaryConfig",
  "salaryManagedBy", "managingCompanyId",
  "legalDocuments",
];
const OBJECT_ID_REF_FIELDS = ["hrmsBranchId", "department", "designation", "shiftId", "managingCompanyId"];

// ── Input checks ────────────────────────────────────────────────────────────
// Run BEFORE anything is saved, so a bad value is a clear 400 instead of a
// Staff login created with a missing/half-synced HRMS profile behind a warning.
const EMPLOYMENT_TYPES = ["permanent", "contract", "intern", "probation", "Full Time", "Part Time", "full-time", "part-time", ""];
const SALARY_PARTS = ["basic", "hra", "da", "conveyance", "medicalAllowance", "specialAllowance", "pf", "esic", "professionalTax"];
const REF_MODELS = { hrmsBranchId: () => HRMSBranch, department: () => HRMSDepartment, designation: () => Designation, shiftId: () => require("../hrms/models/shift_model") };

const checkName = (label, v, required) => {
  if (v === undefined) return required ? `${label} is required` : null;
  const s = String(v ?? "").trim();
  if (required && !s) return `${label} is required`;
  if (s.length > 100) return `${label} must be 100 characters or less`;
  if (/[<>]/.test(s)) return `${label} cannot contain < or >`;
  return null;
};
// At least 8 characters with a letter and a number.
const checkPassword = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  return s.length >= 8 && /[A-Za-z]/.test(s) && /\d/.test(s) ? null : "Password must be at least 8 characters and include a letter and a number";
};
const dayValue = (v) => {
  if (isBlank(v)) return null;
  const d = new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return isNaN(d.getTime()) ? NaN : d.getTime();
};

async function staffInputError(body, { isCreate, tenantId }) {
  const err = firstError(
    checkName("First name", body.firstname, isCreate),
    checkName("Last name", body.lastname, false),
    isCreate && isBlank(body.email) ? "Email is required" : checkEmail("Email", body.email),
    checkPassword(body.password),
    checkNumber("Base salary", body.salaryAmount, { min: 0 }),
    checkPan("PAN number", body.legalDocuments?.panNumber),
    checkAadhaar("Aadhaar number", body.legalDocuments?.aadhaarNumber),
    checkIfsc("IFSC code", body.bankInfo?.ifscCode),
    isBlank(body.bankInfo?.accountNumber) || /^\d{9,18}$/.test(String(body.bankInfo.accountNumber).trim()) ? null : "Account number must be 9 to 18 digits",
    checkPhone("Residential phone", body.residentialPhone),
    checkPhone("Emergency contact phone", body.emergencyContact?.phone),
  );
  if (err) return err;
  if (body.employmentType !== undefined && !EMPLOYMENT_TYPES.includes(body.employmentType)) return "Employment type is not valid";

  const config = body.salaryConfig;
  if (config && typeof config === "object") {
    for (const part of SALARY_PARTS) {
      const e = checkNumber(`Salary ${part}`, config[part]?.value, { min: 0 });
      if (e) return e;
    }
    const basicPlusHra = (Number(config.basic?.value) || 0) + (Number(config.hra?.value) || 0);
    if (!isBlank(body.salaryAmount) && Number(body.salaryAmount) > 0 && basicPlusHra > Number(body.salaryAmount)) {
      return `Basic + HRA (₹${basicPlusHra}) cannot be more than the Base Salary (₹${Number(body.salaryAmount)})`;
    }
  }

  const dob = dayValue(body.dob);
  const joining = dayValue(body.joiningDate);
  if (Number.isNaN(dob)) return "Date of birth is not a valid date";
  if (Number.isNaN(joining)) return "Joining date is not a valid date";
  if (dob !== null && dob > Date.now()) return "Date of birth cannot be in the future";
  if (dob !== null && joining !== null && joining < dob) return "Joining date cannot be before the date of birth";

  // Branch / department / designation / shift must be real records of this company.
  for (const [field, model] of Object.entries(REF_MODELS)) {
    const v = body[field];
    if (isBlank(v) || v === "none") continue;
    if (!mongoose.Types.ObjectId.isValid(String(v))) return `${field} is not a valid id`;
    if (!(await model().exists({ _id: v, tenant_id: tenantId || null }))) return `${field} does not belong to this company`;
  }
  return null;
}

// PAN / IFSC are stored upper-case and Aadhaar as plain digits, however they were typed.
function normalizeStaffFormats(body) {
  if (body.legalDocuments?.panNumber) body.legalDocuments.panNumber = String(body.legalDocuments.panNumber).trim().toUpperCase();
  if (body.legalDocuments?.aadhaarNumber) body.legalDocuments.aadhaarNumber = String(body.legalDocuments.aadhaarNumber).replace(/[\s-]/g, "");
  if (body.bankInfo?.ifscCode) body.bankInfo.ifscCode = String(body.bankInfo.ifscCode).trim().toUpperCase();
}

// A non-admin may only hand out capabilities they hold themselves.
const permissionsWithinOwn = (granted, mine) => {
  const plain = (p) => (p instanceof Map ? Object.fromEntries([...p].map(([k, v]) => [k, v instanceof Map ? Object.fromEntries(v) : v])) : (p || {}));
  const own = plain(mine);
  const out = {};
  for (const [mod, caps] of Object.entries(plain(granted))) {
    const allowed = Object.entries(caps || {}).filter(([cap, on]) => on && own[mod]?.[cap]);
    if (allowed.length) out[mod] = Object.fromEntries(allowed);
  }
  return out;
};

// Expands req.body once — dot-notation keys (from FormData, e.g. "bankInfo.accountName")
// back into nested objects/arrays, folding in any uploaded avatar/PAN/Aadhaar/passport-photo
// files (multer .any() results) the same way user_controller.js's createUser/updateUser do.
// createStaff/updateStaff destructure identity fields from this, and extractHrmsProfileFields
// pulls the HRMS-domain subset from the same expanded object — never re-expand req.body twice.
const expandBody = (req) => {
  const rawData = { ...req.body };
  if (req.files && Array.isArray(req.files)) {
    req.files.forEach((file) => {
      if (file.fieldname === "pan") rawData["legalDocuments.panUrl"] = file.path;
      if (file.fieldname === "aadhaar") rawData["legalDocuments.aadhaarUrl"] = file.path;
      if (file.fieldname === "passportPhoto") rawData["legalDocuments.passportPhotoUrl"] = file.path;
      if (file.fieldname === "avatar") rawData["avatar"] = file.path;
    });
  }
  ["legalDocuments.panUrl", "legalDocuments.aadhaarUrl", "legalDocuments.passportPhotoUrl", "avatar"].forEach((key) => {
    if (rawData[key]) rawData[key] = toPublicUploadPath(rawData[key]);
  });
  return expandDotNotation(rawData);
};

const extractHrmsProfileFields = (expandedBody) => {
  const hrmsFields = {};
  for (const key of HRMS_PROFILE_FIELDS) {
    if (expandedBody[key] !== undefined) hrmsFields[key] = expandedBody[key];
  }
  if (expandedBody.avatar !== undefined) hrmsFields.avatar = expandedBody.avatar;
  return hrmsFields;
};

// User has no `salaryConfig` field of its own — mirrors user_controller.js's
// identical interception so Setup > Staff and HRMS > Staff Directory save
// Basic/HRA/PF/ESIC the same way, into the same SalaryStructure collection
// payroll_controller.generatePayroll actually reads from. Without this, the
// Salary Breakdown box silently drops whatever was typed into it.
const applySalaryConfig = async (hrmsFields, existingSalaryStructureId, employeeName) => {
  if (!hrmsFields.salaryConfig) return;
  const config = hrmsFields.salaryConfig;
  const structureData = salaryStructureFromConfig(config);

  let structure = existingSalaryStructureId
    ? await SalaryStructure.findById(existingSalaryStructureId)
    : null;

  if (structure) {
    Object.assign(structure, structureData);
    await structure.save();
  } else {
    structure = await SalaryStructure.create({
      name: `${employeeName || "Employee"}'s Salary Structure (${Date.now()})`,
      ...structureData,
      conveyance: 0,
      medicalAllowance: 0,
      specialAllowance: 0,
      isActive: true,
    });
  }

  hrmsFields.salaryStructureId = structure._id;
  delete hrmsFields.salaryConfig;
};

// Setup > Staff is the single place staff get created — mirror every
// create/update/delete onto the linked HRMS employee profile (src/hrms/models/user_model.js)
// so Setup > Staff and HRMS > Staff Directory always show the same person.
// Non-fatal by design: a hiccup here must never block the Staff operation itself —
// callers surface `hrmsSyncError` to the admin as a warning instead (see createStaff/
// updateStaff), rather than only logging it server-side where nobody sees it.
// Returns the auto-generated password when one had to be created (so the
// caller can hand it back to the admin), or null when none was needed.
const linkHrmsProfile = async (staff, plainPassword, hrmsFields = {}) => {
  try {
    // Scoped to this staff's own tenant — an unscoped email lookup here would
    // match another tenant's HRMS user with the same email and silently link
    // this staff to someone else's profile (invisible in this tenant's HRMS
    // Staff Directory, since user_controller.js's getUsers filters by tenant_id).
    const existing = await User.findOne({ email: staff.email, tenant_id: staff.tenant_id || null });
    if (existing) {
      staff.hrms_user_id = existing._id;
      await staff.save();
      const linkUpdate = {};
      if (!existing.staffId) linkUpdate.staffId = staff._id;
      Object.assign(linkUpdate, hrmsFields);
      if (Object.keys(linkUpdate).length > 0) {
        await User.findByIdAndUpdate(existing._id, linkUpdate);
      }
      return { generatedPassword: null, hrmsSyncError: null };
    }

    let generatedPassword = null;
    let passwordToUse = plainPassword;
    if (!passwordToUse) {
      generatedPassword = generateTempPassword();
      passwordToUse = generatedPassword;
      // Re-hash the real password onto Staff too — it was created with an
      // empty-string password (schema's required:true accepts "" as present).
      staff.password = generatedPassword;
      await staff.save();
    }

    const hrmsUser = await User.create({
      name: `${staff.firstname} ${staff.lastname}`.trim(),
      email: staff.email,
      password: passwordToUse,
      mobile: staff.phonenumber || "",
      isActive: staff.active !== false,
      staffId: staff._id,
      tenant_id: staff.tenant_id || null,
      ...hrmsFields,
    });
    staff.hrms_user_id = hrmsUser._id;
    await staff.save();
    return { generatedPassword, hrmsSyncError: null };
  } catch (err) {
    console.error("Failed to sync HRMS employee profile for staff:", err.message);
    return { generatedPassword: null, hrmsSyncError: err.message };
  }
};

const syncHrmsProfile = async (staff, fields, hrmsFields = {}) => {
  try {
    if (!staff.hrms_user_id) return { hrmsSyncError: null };
    const update = {};
    if (fields.firstname !== undefined || fields.lastname !== undefined) {
      update.name = `${staff.firstname} ${staff.lastname}`.trim();
    }
    if (fields.email !== undefined) update.email = staff.email;
    if (fields.phonenumber !== undefined) update.mobile = staff.phonenumber || "";
    if (fields.active !== undefined) update.isActive = staff.active !== false;
    // findByIdAndUpdate skips User's pre("save") hash hook, so hash here —
    // same manual-hash pattern user_controller.js's updateUser already uses
    // for the reverse direction (HRMS User -> Staff password sync).
    if (fields.password) update.password = await bcrypt.hash(String(fields.password), 10);
    Object.assign(update, hrmsFields);
    // Same legacy-reference guard as user_controller.updateUser: an old
    // non-ObjectId branch/department value would CastError the whole update,
    // leaving name/password out of sync too — drop just that field instead.
    for (const field of OBJECT_ID_REF_FIELDS) {
      const value = update[field];
      if (value != null && typeof value === "string" && !mongoose.Types.ObjectId.isValid(value)) delete update[field];
    }
    if (Object.keys(update).length === 0) return { hrmsSyncError: null };
    await User.findByIdAndUpdate(staff.hrms_user_id, update, { runValidators: true });
    return { hrmsSyncError: null };
  } catch (err) {
    console.error("Failed to sync HRMS employee profile update:", err.message);
    return { hrmsSyncError: err.message };
  }
};

// Turns a raw sync error into a message worth showing an admin — vague enough
// to not leak internals, specific enough to point at HRMS > Staff Directory.
const hrmsSyncWarningMessage = (err) =>
  `Staff saved, but the linked HRMS employee profile could not be synced (${err}). Check HRMS > Staff Directory.`;

const getStaff = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.json([]);
    }

    // If super admin, only show global staff (tenant_id is null or missing). 
    // If tenant, only show staff belonging to that tenant, BUT hide the tenant owner.
    let query = {};
    if (req.user?.is_superadmin) {
      query = { tenant_id: null };
    } else {
      query = { 
        tenant_id: req.user?.tenant_id,
      };
    }
      
    const staff = await Staff.find(query).select("-password").populate("role");

    // Include custom field values for each staff — one batched query for
    // the whole list instead of one query per staff member.
    const cfByStaff = await CustomFieldService.getValuesForMany(staff.map((m) => m._id), "staff");
    // Profile pictures live on the linked HRMS User, not on Staff — one batched
    // lookup so the Setup > Staff list can show the same photo HRMS does.
    const hrmsIds = staff.map((m) => m.hrms_user_id).filter(Boolean);
    const avatarByUser = new Map();
    if (hrmsIds.length) {
      const users = await User.find({ _id: { $in: hrmsIds } }).select("avatar").lean();
      users.forEach((u) => { if (u.avatar) avatarByUser.set(String(u._id), u.avatar); });
    }
    const staffWithCustomFields = staff.map((member) => {
      const memberObj = member.toObject();
      memberObj.custom_fields = cfByStaff.get(String(member._id)) || {};
      memberObj.avatar = avatarByUser.get(String(member.hrms_user_id)) || "";
      // Convert Mongoose Map to plain object
      if (memberObj.permissions instanceof Map) {
        const plainPerms = {};
        memberObj.permissions.forEach((value, key) => {
          plainPerms[key] =
            value instanceof Map ? Object.fromEntries(value) : value;
        });
        memberObj.permissions = plainPerms;
      }
      return memberObj;
    });

    res.json(staffWithCustomFields);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Lightweight staff list for Assignees/Followers-style pickers. Deliberately NOT
// gated by checkPermission("Staff", "View") — Task/Project assignment is a separate
// concern from Staff-module management, so any authenticated tenant staff member
// (regardless of their "Staff" module permission) can populate these dropdowns.
const getAssignableStaff = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.json([]);
    }

    const query = req.user?.is_superadmin
      ? { tenant_id: null }
      : { tenant_id: req.user?.tenant_id };

    const staff = await Staff.find(query).select(
      "firstname lastname email active",
    );

    res.json(staff);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getStaffById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const staff = await Staff.findOne(query)
      .select("-password")
      .populate("role");
    if (staff) {
      const custom_fields_values = await CustomFieldService.getValues(
        staff._id,
        "staff",
      );
      const staffObj = staff.toObject();
      staffObj.custom_fields = custom_fields_values;
      // Convert Mongoose Map to plain object so frontend can access keys normally
      if (staffObj.permissions instanceof Map) {
        const plainPerms = {};
        staffObj.permissions.forEach((value, key) => {
          plainPerms[key] =
            value instanceof Map ? Object.fromEntries(value) : value;
        });
        staffObj.permissions = plainPerms;
      }

      // Merge in the linked HRMS employee profile's Employment/Salary/Legal
      // Documents fields so the edit form can show what was collected there too.
      try {
        // Also select+populate salaryStructureId (not itself an HRMS_PROFILE_FIELDS
        // entry) so mapSalaryStructureToConfig can reconstruct the real, saved
        // Basic/HRA/PF/ESIC — mirrors user_controller.js's getUserById exactly,
        // so this page shows the same numbers HRMS > Staff Directory would.
        const hrmsSelect = HRMS_PROFILE_FIELDS.join(" ") + " avatar salaryStructureId";
        const hrmsUser = staff.hrms_user_id
          ? await User.findById(staff.hrms_user_id).select(hrmsSelect).populate("salaryStructureId")
          : await User.findOne({ email: staff.email, tenant_id: staff.tenant_id || null }).select(hrmsSelect).populate("salaryStructureId");
        if (hrmsUser) {
          const hrmsObj = mapSalaryStructureToConfig(hrmsUser);
          for (const key of [...HRMS_PROFILE_FIELDS, "avatar"]) {
            if (hrmsObj[key] !== undefined) staffObj[key] = hrmsObj[key];
          }
          staffObj.managingBranchId = await branchIdForManagingCompany(hrmsObj.managingCompanyId);
        }
      } catch (err) {
        console.error("Failed to load linked HRMS employee profile:", err.message);
      }

      res.json(staffObj);
    } else {
      res.status(404).json({ message: "Staff not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createStaff = async (req, res) => {
  // Expanded once — handles both plain JSON bodies and multipart/form-data bodies
  // (dot-notation keys + uploaded files) sent when the Employment/Salary/Legal
  // Documents tabs are filled in.
  const body = expandBody(req);
  const {
    firstname,
    lastname,
    email,
    phonenumber,
    admin,
    role,
    custom_fields,
    skype,
    facebook,
    linkedin,
    default_language,
    direction,
    email_signature,
    departments,
    permissions,
  } = body;
  // Coerce to string first — expandDotNotation may have cast a digit-only password to a number
  let password = body.password !== undefined && body.password !== null ? String(body.password) : body.password;

  try {
    const tenant_id = req.user?.is_superadmin ? body.tenant_id : req.user?.tenant_id;

    const invalid = await staffInputError(body, { isCreate: true, tenantId: tenant_id });
    if (invalid) return res.status(400).json({ message: invalid });
    normalizeStaffFormats(body);

    // A blank Password gets a temporary one up front — Staff's schema rejects "".
    let generatedPassword = null;
    if (!password) {
      generatedPassword = generateTempPassword();
      password = generatedPassword;
    }

    // One email / one mobile = one account across every company; mobile is
    // required and exactly 10 digits (utils/accountUniqueness.js).
    const check = await checkAccount({
      kind: "staff", email, phone: phonenumber, tenantId: tenant_id || null, requirePhone: true,
    });
    if (rejectAccountConflict(res, check)) return;
    const normalizedPhone = check.phone;

    // Plan's Team Members limit (utils/planLimits.js).
    if (await rejectIfStaffLimit(req, res, tenant_id)) return;

    // Only an existing admin/superadmin may grant admin rights to a new staff member
    const canGrantAdmin = req.user?.admin || req.user?.is_superadmin;

    const staff = await Staff.create({
      firstname: String(firstname).trim(),
      lastname: lastname === undefined ? lastname : String(lastname).trim(),
      email,
      password,
      phonenumber: normalizedPhone,
      admin: canGrantAdmin ? !!admin : false,
      // Roles and permissions carry access: an admin sets them freely; anyone
      // else can only pass on capabilities they hold themselves, and no role.
      role: canGrantAdmin ? role || null : null,
      skype,
      facebook,
      linkedin,
      default_language,
      direction,
      email_signature,
      departments: departments || [],
      permissions: canGrantAdmin ? permissions || {} : permissionsWithinOwn(permissions, req.user?.permissions),
      active: body.active !== undefined ? body.active : true,
      tenant_id,
    });

    if (staff) {
      // Handle custom fields
      if (custom_fields) {
        await CustomFieldService.handlePost(staff._id, "staff", custom_fields, staff.tenant_id);
      }

      // Mirror into the HRMS employee directory so this staff member shows up
      // there immediately without a second, separate creation step.
      const hrmsFields = extractHrmsProfileFields(body);
      await applyManagingBranch(body, hrmsFields, staff.tenant_id);
      await applySalaryConfig(hrmsFields, null, `${staff.firstname} ${staff.lastname}`);
      const { hrmsSyncError } = await linkHrmsProfile(staff, password, hrmsFields);

      logActivity(req, `Added new staff member: ${staff.firstname} ${staff.lastname}`, { rel_id: staff._id, rel_type: "staff" });

      res.status(201).json({
        _id: staff._id,
        firstname: staff.firstname,
        lastname: staff.lastname,
        email: staff.email,
        admin: staff.admin,
        // Only set when the Password field was left blank — the frontend
        // should surface this once so the admin can hand it to the employee;
        // it cannot be recovered afterwards (only stored as a bcrypt hash).
        ...(generatedPassword ? { generatedPassword } : {}),
        // Staff creation itself still succeeded (201) even when this is set —
        // only the HRMS mirror failed. Surfaced so it isn't only a server log.
        ...(hrmsSyncError ? { hrmsSyncWarning: hrmsSyncWarningMessage(hrmsSyncError) } : {}),
      });
    } else {
      res.status(400).json({ message: "Invalid staff data" });
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Staff member already exists" });
    }
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// Bulk-creates staff from a spreadsheet (rows already parsed client-side, same
// convention as invoice_controller.importInvoices — see ImportDialog on the
// frontend). Never grants admin rights from a sheet, and reuses linkHrmsProfile
// per row so imported staff show up in HRMS > Staff Directory exactly like a
// single manual create does.
const importStaff = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.staff;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0)
      return res.status(400).json({ message: "No valid staff data provided" });

    const tenant_id = req.user?.is_superadmin ? req.body.tenant_id : req.user?.tenant_id;

    // Case + space + special-char insensitive field reader (same helper shape
    // invoice_controller.importInvoices uses).
    const normalizeKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9#]/g, "");
    const buildKeyMap = (r) => new Map(Object.keys(r).map((k) => [normalizeKey(k), k]));
    const getVal = (r, km, ...names) => {
      for (const name of names) {
        const ak = km.get(normalizeKey(name));
        if (ak !== undefined && r[ak] !== undefined && r[ak] !== null && r[ak] !== "") return r[ak];
      }
      return "";
    };
    const parseActive = (v) => {
      if (v === undefined || v === null || v === "") return true;
      return ["yes", "true", "1", "active"].includes(String(v).trim().toLowerCase());
    };
    const parseDate = (v) => {
      if (!v) return undefined;
      if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v;
      const n = Number(v);
      if (!isNaN(n) && n > 40000 && n < 60000) return new Date((n - 25569) * 86400 * 1000);
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
    };
    const parseNum = (v) => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = Number(String(v).replace(/[^0-9.-]+/g, ""));
      return isNaN(n) ? undefined : n;
    };

    const keyMaps = rowsRaw.map((r) => buildKeyMap(r));

    // Batch-resolve name -> id lookups once, not per row. Department/Designation/
    // Branch are unique per tenant (not globally, unlike Role) — see their schemas.
    const namesFor = (...aliases) => [...new Set(
      rowsRaw.map((r, i) => String(getVal(r, keyMaps[i], ...aliases) || "").trim()).filter(Boolean)
    )];
    const findByNameMap = async (Model, names, extraFilter = {}) => {
      if (!names.length) return new Map();
      const docs = await Model.find({
        name: { $in: names.map((n) => new RegExp(`^${n}$`, "i")) },
        ...extraFilter,
      });
      return new Map(docs.map((d) => [d.name.toLowerCase(), d._id]));
    };

    const roleNames = namesFor("Role", "role");
    const departmentNames = namesFor("HRMS Department", "department", "hrmsdepartment");
    const designationNames = namesFor("Designation", "designation");
    const branchNames = namesFor("Branch", "branch");

    const [roleMap, departmentMap, designationMap, branchMap] = await Promise.all([
      // This company's roles plus shared defaults — never another company's role.
      findByNameMap(Role, roleNames, { tenant_id: { $in: [tenant_id || null, null] } }),
      findByNameMap(HRMSDepartment, departmentNames, { tenant_id: tenant_id || null }),
      findByNameMap(Designation, designationNames, { tenant_id: tenant_id || null }),
      findByNameMap(HRMSBranch, branchNames, { tenant_id: tenant_id || null }),
    ]);

    let created = 0;
    let skippedDuplicate = 0;
    let skippedInvalid = 0;
    const errors = [];
    // Emails/mobiles already taken by an earlier row of this same file.
    const fileEmails = new Set();
    const filePhones = new Set();

    for (let i = 0; i < rowsRaw.length; i++) {
      const r = rowsRaw[i];
      const km = keyMaps[i];

      const firstname = String(getVal(r, km, "First Name", "firstname") || "").trim();
      const lastname = String(getVal(r, km, "Last Name", "lastname") || "").trim();
      const email = String(getVal(r, km, "Email", "email") || "").trim().toLowerCase();

      if (!firstname || !lastname || !email) {
        skippedInvalid++;
        errors.push(`Row ${i + 2}: First Name, Last Name and Email are required`);
        continue;
      }
      const rowError = firstError(
        checkName("First name", firstname, true),
        checkName("Last name", lastname, false),
        checkEmail("Email", email),
        checkPassword(getVal(r, km, "Password", "password")),
      );
      if (rowError) {
        skippedInvalid++;
        errors.push(`Row ${i + 2} (${email}): ${rowError}`);
        continue;
      }

      // Same one-email/one-mobile rule as a single create, across every company.
      const rawPhone = String(getVal(r, km, "Phone Number", "Phone", "phonenumber") || "");
      const check = fileEmails.has(email)
        ? { ok: false, field: "email", message: EMAIL_TAKEN_MESSAGE }
        : await checkAccount({ kind: "staff", email, phone: rawPhone, tenantId: tenant_id || null, requirePhone: true });
      if (!check.ok && check.field === "email") {
        skippedDuplicate++;
        errors.push(`Row ${i + 2} (${email}): ${check.message}`);
        continue;
      }
      if (!check.ok || filePhones.has(check.phone)) {
        skippedInvalid++;
        errors.push(`Row ${i + 2} (${email}): ${check.ok ? PHONE_TAKEN_MESSAGE : check.message}${rawPhone ? ` (${rawPhone})` : ""}`);
        continue;
      }
      const phonenumber = check.phone;

      const roleName = String(getVal(r, km, "Role", "role") || "").trim().toLowerCase();
      // "Departments" (plural) is Staff's own free-text tag list — distinct from the
      // singular "HRMS Department" org-unit lookup resolved into departmentMap below.
      const departmentsRaw = String(getVal(r, km, "Departments") || "");
      // Blank cell → a temporary password (Staff's schema rejects ""); the
      // employee resets it via Forgot Password.
      const password = String(getVal(r, km, "Password", "password") || "") || generateTempPassword();

      const departmentName = String(getVal(r, km, "HRMS Department", "department", "hrmsdepartment") || "").trim().toLowerCase();
      const designationName = String(getVal(r, km, "Designation", "designation") || "").trim().toLowerCase();
      const branchName = String(getVal(r, km, "Branch", "branch") || "").trim().toLowerCase();

      const hrmsFields = {
        gender: String(getVal(r, km, "Gender", "gender") || "") || undefined,
        dob: parseDate(getVal(r, km, "DOB", "Date of Birth", "dob")),
        bloodGroup: String(getVal(r, km, "Blood Group", "bloodGroup") || "") || undefined,
        education: String(getVal(r, km, "Education", "education") || "") || undefined,
        totalExperience: String(getVal(r, km, "Experience", "Total Experience", "totalExperience") || "") || undefined,
        department: departmentMap.get(departmentName) || undefined,
        designation: designationMap.get(designationName) || undefined,
        hrmsBranchId: branchMap.get(branchName) || undefined,
        joiningDate: parseDate(getVal(r, km, "Joining Date", "joiningDate")),
        employmentType: String(getVal(r, km, "Employment Type", "employmentType") || "") || undefined,
        attendanceRequired: (() => {
          const v = getVal(r, km, "Attendance Required", "attendanceRequired");
          return v === "" ? undefined : parseActive(v);
        })(),
        weeklyHolidays: (() => {
          const v = String(getVal(r, km, "Weekly Holidays", "weeklyHolidays") || "");
          return v ? v.split(",").map((d) => d.trim()).filter(Boolean) : undefined;
        })(),
        payType: String(getVal(r, km, "Pay Type", "payType") || "") || undefined,
        salaryAmount: parseNum(getVal(r, km, "Salary Amount", "salaryAmount")),
        residentialPhone: String(getVal(r, km, "Residential Phone", "residentialPhone") || "") || undefined,
        address: (() => {
          const current = String(getVal(r, km, "Address", "address") || "");
          return current ? { current } : undefined;
        })(),
        emergencyContact: (() => {
          const name = String(getVal(r, km, "Emergency Contact Name") || "");
          const phone = String(getVal(r, km, "Emergency Contact Phone") || "");
          return name || phone ? { name, phone } : undefined;
        })(),
        bankInfo: (() => {
          const bankName = String(getVal(r, km, "Bank Name", "bankName") || "");
          const accountNumber = String(getVal(r, km, "Account Number", "accountNumber") || "");
          const ifscCode = String(getVal(r, km, "IFSC Code", "ifscCode") || "");
          return bankName || accountNumber || ifscCode ? { bankName, accountNumber, ifscCode } : undefined;
        })(),
      };
      // Drop undefined keys so linkHrmsProfile's User.create doesn't stomp schema
      // defaults (e.g. payType's "Monthly" default) with an explicit undefined.
      Object.keys(hrmsFields).forEach((k) => hrmsFields[k] === undefined && delete hrmsFields[k]);
      const hrmsError = await staffInputError(hrmsFields, { isCreate: false, tenantId: tenant_id });
      if (hrmsError) {
        skippedInvalid++;
        errors.push(`Row ${i + 2} (${email}): ${hrmsError}`);
        continue;
      }
      normalizeStaffFormats(hrmsFields);

      // Plan's Team Members limit: an active row needs a free seat.
      if (!req.user?.is_superadmin && parseActive(getVal(r, km, "Active", "active")) !== false) {
        const seat = await checkStaffLimit(tenant_id);
        if (!seat.allowed) {
          skippedInvalid++;
          errors.push(`Row ${i + 2} (${email}): ${seat.message}`);
          continue;
        }
      }

      try {
        const staff = await Staff.create({
          firstname,
          lastname,
          email,
          password,
          phonenumber,
          admin: false,
          role: roleMap.get(roleName) || null,
          skype: String(getVal(r, km, "Skype", "skype") || ""),
          facebook: String(getVal(r, km, "Facebook", "facebook") || ""),
          linkedin: String(getVal(r, km, "LinkedIn", "linkedin") || ""),
          default_language: String(getVal(r, km, "Default Language", "default_language") || ""),
          departments: departmentsRaw ? departmentsRaw.split(",").map((d) => d.trim()).filter(Boolean) : [],
          active: parseActive(getVal(r, km, "Active", "active")),
          tenant_id,
        });

        await linkHrmsProfile(staff, password, hrmsFields);
        fileEmails.add(email);
        filePhones.add(phonenumber);
        created++;
      } catch (err) {
        skippedInvalid++;
        const reason = err.code === 11000 ? "Staff member already exists" : err.message;
        errors.push(`Row ${i + 2} (${email}): ${reason}`);
      }
    }

    logActivity(req, `Imported ${created} staff member(s)`, { rel_type: "staff" });

    res.status(201).json({
      message: `Imported ${created} staff member(s).${skippedDuplicate ? ` ${skippedDuplicate} skipped (already exist).` : ""}${skippedInvalid ? ` ${skippedInvalid} row(s) failed — see errors.` : ""}`,
      count: created,
      skippedDuplicate,
      skippedInvalid,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateStaff = async (req, res) => {
  const body = expandBody(req);
  const { custom_fields, ...updateData } = body;
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    
    const staff = await Staff.findOne(query);

    if (staff) {
      const isAdmin = !!(req.user?.admin || req.user?.is_superadmin);
      const isSelf = String(staff._id) === String(req.user?._id);
      // A non-admin changing an admin's email/password would take the account over.
      if (!isAdmin && (staff.admin || staff.is_superadmin) && !isSelf) {
        return res.status(403).json({ message: "Only an admin can edit an admin account" });
      }
      const invalid = await staffInputError(body, { isCreate: false, tenantId: staff.tenant_id });
      if (invalid) return res.status(400).json({ message: invalid });
      normalizeStaffFormats(body);
      if (!isAdmin) {
        // Your own profile: details only — never your own access.
        if (isSelf) {
          delete updateData.permissions;
          delete updateData.permissionsCleared;
          delete updateData.role;
          delete updateData.active;
        } else {
          delete updateData.role;
          if (updateData.permissions !== undefined) {
            updateData.permissions = permissionsWithinOwn(updateData.permissions, req.user?.permissions);
          }
        }
      }

      // One email / one mobile = one account (utils/accountUniqueness.js).
      // Only fields actually sent are checked, so side actions (e.g. an
      // Active toggle) never fail on an old account without a mobile; a form
      // that sends the mobile must send a valid 10-digit one.
      const emailChanged =
        updateData.email !== undefined && normalizeEmail(updateData.email) !== normalizeEmail(staff.email);
      const phoneSent = updateData.phonenumber !== undefined;
      if (emailChanged || phoneSent) {
        const check = await checkAccount({
          kind: "staff",
          email: emailChanged ? updateData.email : undefined,
          phone: phoneSent ? updateData.phonenumber : undefined,
          requirePhone: phoneSent,
          staffId: staff._id,
          userId: staff.hrms_user_id,
          tenantId: staff.tenant_id || null,
        });
        // Re-saving the account's own current number is never a conflict.
        const ownPhone = phoneSent && normalizePhone(updateData.phonenumber).phone === normalizePhone(staff.phonenumber).phone;
        if (!check.ok && !(check.field === "phone" && ownPhone && check.message === PHONE_TAKEN_MESSAGE)) {
          return rejectAccountConflict(res, check);
        }
        if (phoneSent) updateData.phonenumber = normalizePhone(updateData.phonenumber).phone;
      }

      // Basic Info - only update if provided
      if (updateData.firstname !== undefined) staff.firstname = String(updateData.firstname).trim();
      if (updateData.lastname !== undefined) staff.lastname = String(updateData.lastname ?? "").trim();
      if (updateData.email !== undefined) staff.email = updateData.email;
      if (updateData.phonenumber !== undefined) staff.phonenumber = updateData.phonenumber;
      if (updateData.admin !== undefined) {
        const canGrantAdmin = req.user?.admin || req.user?.is_superadmin;
        if (canGrantAdmin) staff.admin = updateData.admin;
      }
      if (updateData.active !== undefined) {
        // Re-activating a staff member takes a seat in the plan's Team Members limit.
        const activating = staff.active === false && updateData.active !== false && updateData.active !== "false";
        if (activating && (await rejectIfStaffLimit(req, res, staff.tenant_id))) return;
        staff.active = updateData.active;
      }

      // Role - if explicitly passed as 'none' or null/undefined, handle correctly
      if (updateData.hasOwnProperty("role")) {
        staff.role = updateData.role || null;
      }
      
      if (updateData.hasOwnProperty("permissions")) {
        staff.permissions = updateData.permissions || {};
      } else if (updateData.permissionsCleared) {
        // Frontend sends this marker when every permission checkbox was
        // unchecked — an empty object has no keys, so it never survives the
        // FormData dot-notation round trip and "permissions" wouldn't be
        // present above at all.
        staff.permissions = {};
      }

      if (updateData.skype !== undefined) staff.skype = updateData.skype;
      if (updateData.facebook !== undefined) staff.facebook = updateData.facebook;
      if (updateData.linkedin !== undefined) staff.linkedin = updateData.linkedin;
      if (updateData.default_language !== undefined) staff.default_language = updateData.default_language;
      if (updateData.direction !== undefined) staff.direction = updateData.direction;
      if (updateData.email_signature !== undefined) staff.email_signature = updateData.email_signature;
      if (updateData.departments !== undefined) staff.departments = updateData.departments;
      if (updateData.notification_sound !== undefined) staff.notification_sound = updateData.notification_sound;

      // Handle Password Update - only if it has a non-empty value
      // Coerce to string first — expandDotNotation may have cast a digit-only password to a number
      if (updateData.password !== undefined && updateData.password !== null) {
        updateData.password = String(updateData.password).trim();
      }
      if (updateData.password) {
        console.log(`Updating password for staff: ${staff.email}`);
        staff.password = updateData.password;
        // The pre-save hook in Staff.js will handle hashing
      }

      const updatedStaff = await staff.save();

      // Handle custom fields
      if (custom_fields) {
        await CustomFieldService.handlePost(staff._id, "staff", custom_fields, staff.tenant_id);
      }

      // Keep the mirrored HRMS employee profile in sync with identity changes
      // plus the Employment/Salary/Legal Documents fields collected here too.
      const hrmsFields = extractHrmsProfileFields(body);
      await applyManagingBranch(body, hrmsFields, updatedStaff.tenant_id);
      if (hrmsFields.salaryConfig) {
        let existingSalaryStructureId = null;
        if (updatedStaff.hrms_user_id) {
          const existingHrmsUser = await User.findById(updatedStaff.hrms_user_id).select("salaryStructureId");
          existingSalaryStructureId = existingHrmsUser?.salaryStructureId || null;
        }
        await applySalaryConfig(hrmsFields, existingSalaryStructureId, `${updatedStaff.firstname} ${updatedStaff.lastname}`);
      }
      const { hrmsSyncError } = updatedStaff.hrms_user_id
        ? await syncHrmsProfile(updatedStaff, updateData, hrmsFields)
        : await linkHrmsProfile(updatedStaff, updateData.password, hrmsFields);

      logActivity(req, `Updated staff member: ${updatedStaff.firstname} ${updatedStaff.lastname}`, { rel_id: updatedStaff._id, rel_type: "staff" });

      res.json({
        _id: updatedStaff._id,
        firstname: updatedStaff.firstname,
        lastname: updatedStaff.lastname,
        email: updatedStaff.email,
        admin: updatedStaff.admin,
        ...(hrmsSyncError ? { hrmsSyncWarning: hrmsSyncWarningMessage(hrmsSyncError) } : {}),
      });
    } else {
      res.status(404).json({ message: "Staff not found" });
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Staff member already exists" });
    }
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteStaff = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const staff = await Staff.findOne(query);

    if (staff) {
      // Never lock a company out: no deleting yourself, and only an admin may
      // remove an admin (the company owner only by a super admin).
      if (String(staff._id) === String(req.user?._id)) {
        return res.status(400).json({ message: "You cannot delete your own account" });
      }
      const isAdmin = !!(req.user?.admin || req.user?.is_superadmin);
      if ((staff.admin || staff.is_superadmin) && !isAdmin) {
        return res.status(403).json({ message: "Only an admin can delete an admin account" });
      }
      if (!req.user?.is_superadmin && staff.tenant_id && (await Tenant.exists({ _id: staff.tenant_id, owner_id: staff._id }))) {
        return res.status(403).json({ message: "The company owner's account cannot be deleted" });
      }

      const staffName = `${staff.firstname} ${staff.lastname}`;

      // Deactivate (never hard-delete) the mirrored HRMS employee profile so
      // historical attendance/payroll/leave records tied to that profile stay valid.
      try {
        const hrmsUser = staff.hrms_user_id
          ? await User.findById(staff.hrms_user_id)
          : await User.findOne({ email: staff.email, tenant_id: staff.tenant_id || null });
        if (hrmsUser) {
          hrmsUser.isActive = false;
          await hrmsUser.save();
        }
      } catch (err) {
        console.error("Failed to deactivate linked HRMS employee profile:", err.message);
      }

      await staff.deleteOne();
      logActivity(req, `Deleted staff member: ${staffName}`, { rel_type: "staff" });
      res.json({ message: "Staff member removed" });
    } else {
      res.status(404).json({ message: "Staff not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getStaff,
  getAssignableStaff,
  getStaffById,
  createStaff,
  importStaff,
  updateStaff,
  deleteStaff,
  linkHrmsProfile,
  syncHrmsProfile,
};
