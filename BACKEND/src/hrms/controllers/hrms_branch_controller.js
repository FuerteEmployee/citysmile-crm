const mongoose = require("mongoose");
const HRMSBranch = require("../models/hrms_branch_model");
const BranchType = require("../models/branch_type_model");
const User = require("../models/user_model");
const { getBranchScope, isTenantAdmin } = require("../utils/branchScope");
const { checkNumber, checkPincode, checkEmail, firstError, isBlank } = require("../utils/fieldRules");

// Branch phone may be a mobile or a landline with STD code: 10–12 digits,
// spaces / dashes / leading + allowed, no letters.
const checkBranchPhone = (v) => {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const digits = s.replace(/\D/g, "").length;
  return /^\+?[\d\s-]+$/.test(s) && digits >= 10 && digits <= 12 ? null : "Phone must be a 10-digit mobile or a landline with STD code (digits only)";
};
const branchFieldError = (b) => firstError(
  checkBranchPhone(b.phone),
  checkEmail("Email", b.email),
  checkPincode("PIN code", b.pincode),
  checkNumber("Latitude", b.latitude, { min: -90, max: 90 }),
  checkNumber("Longitude", b.longitude, { min: -180, max: 180 }),
  // 0 is tolerated while geo-fencing is off (older branches store it that way).
  checkNumber("Geo-fence radius", b.radius, b.geoFenceEnabled ? { positive: true, max: 100000 } : { min: 0, max: 100000 }),
);

const BRANCH_POPULATE = [
  { path: "branchType", select: "_id name isActive" },
  { path: "quotationTypes", select: "_id name slug" },
  { path: "supervisorIds", select: "_id name email" },
];

// Supervisors grant branch-wide approval rights, so only tenant admins may set
// them, and only to employees of the same tenant. Returns an error message or null;
// normalises body.supervisorIds to a clean id array when allowed.
async function applySupervisors(req, body) {
  if (body.supervisorIds === undefined) return null;
  if (!(await isTenantAdmin(req))) return "Only an admin can assign branch supervisors";
  const ids = (Array.isArray(body.supervisorIds) ? body.supervisorIds : [])
    .map((s) => (s && typeof s === "object" ? s._id : s))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  const tenant_id = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);
  const found = await User.countDocuments({ _id: { $in: ids }, tenant_id });
  if (found !== new Set(ids.map(String)).size) return "One or more supervisors were not found";
  body.supervisorIds = [...new Set(ids.map(String))];
  return null;
}

// GET /hrms-branches/my-scope — tells the UI whether the logged-in user is a
// branch supervisor (and of which branches), so it can show manager views.
exports.getMyBranchScope = async (req, res) => {
  try {
    const scope = await getBranchScope(req);
    res.status(200).json({
      success: true,
      data: scope
        ? { isSupervisor: true, branches: scope.branchIds.map((id, i) => ({ _id: id, name: scope.branchNames[i] })) }
        : { isSupervisor: false, branches: [] },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createHRMSBranch = async (req, res) => {
  try {
    const invalid = branchFieldError(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    // Accept branchType as ObjectId string; reject "*None" sentinel
    const body = { ...req.body };
    if (!body.branchType || body.branchType === "*None") body.branchType = null;
    // Scope to the requester's own tenant — never trust a client-supplied tenant_id
    body.tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);
    const supervisorError = await applySupervisors(req, body);
    if (supervisorError) return res.status(403).json({ success: false, message: supervisorError });

    const branch = new HRMSBranch(body);
    await branch.save();
    const populated = await HRMSBranch.findById(branch._id).populate(BRANCH_POPULATE);
    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A branch with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllHRMSBranches = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, limit: 0, totalPages: 0 },
        stats: { total: 0, active: 0, inactive: 0 },
      });
    }

    const { page = 1, limit = 10, search = "", state, city, branchType, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Scope to the requester's own tenant — see auth_middleware.js's `protect`, which
    // resolves req.user.tenant_id for both the CRM-staff-bridged and native HRMS login paths.
    const tenantFilter = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id };

    const query = { ...tenantFilter };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
      ];
    }
    if (state) query.state = { $regex: state, $options: "i" };
    if (city) query.city = { $regex: city, $options: "i" };
    if (status) query.status = status;

    // branchType filter: match by ObjectId (frontend sends the _id)
    if (branchType && branchType !== "all") {
      query.branchType = branchType;
    }

    const [data, total] = await Promise.all([
      HRMSBranch.find(query).populate(BRANCH_POPULATE).sort({ name: 1 }).skip(skip).limit(parseInt(limit)),
      HRMSBranch.countDocuments(query),
    ]);

    const [activeCount, inactiveCount, totalAll] = await Promise.all([
      HRMSBranch.countDocuments({ ...tenantFilter, status: "Active" }),
      HRMSBranch.countDocuments({ ...tenantFilter, status: "Inactive" }),
      HRMSBranch.countDocuments(tenantFilter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
      stats: { total: totalAll, active: activeCount, inactive: inactiveCount },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getHRMSBranchById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const branch = await HRMSBranch.findOne({ _id: req.params.id, ...tenantFilter }).populate(BRANCH_POPULATE);
    if (!branch) return res.status(404).json({ success: false, message: "HRMS branch not found" });
    res.status(200).json({ success: true, data: branch });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateHRMSBranch = async (req, res) => {
  try {
    const invalid = branchFieldError(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const body = { ...req.body };
    if (!body.branchType || body.branchType === "*None") body.branchType = null;
    delete body.tenant_id; // never reassignable via this endpoint
    const supervisorError = await applySupervisors(req, body);
    if (supervisorError) return res.status(403).json({ success: false, message: supervisorError });

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const before = await HRMSBranch.findOne({ _id: req.params.id, ...tenantFilter }).select("name tenant_id").lean();
    const branch = await HRMSBranch.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true })
      .populate(BRANCH_POPULATE);
    if (!branch) return res.status(404).json({ success: false, message: "HRMS branch not found" });
    // Items and Vendors store the branch NAME, not its id — carry a rename over
    // so they keep showing under the branch filter.
    if (before && before.name !== branch.name) {
      const scope = { tenant_id: before.tenant_id || null, branch: before.name };
      await Promise.all([
        require("../../models/Item").updateMany(scope, { $set: { branch: branch.name } }),
        require("../../models/Vendor").updateMany(scope, { $set: { branch: branch.name } }),
      ]);
    }
    res.status(200).json({ success: true, data: branch });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A branch with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteHRMSBranch = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const branch = await HRMSBranch.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!branch) return res.status(404).json({ success: false, message: "HRMS branch not found" });
    res.status(200).json({ success: true, message: "HRMS branch deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

