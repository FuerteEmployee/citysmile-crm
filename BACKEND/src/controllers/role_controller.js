const Role = require("../models/Role");

// Features already defined in the frontend's Setup > Roles permission grid
// (CRM-FRONTEND/src/pages/setup/SetupRoles.tsx FEATURES_CONFIG).
const HRMS_FEATURES = [
  "HRMS Staff Directory",
  "HRMS Attendance",
  "HRMS Leave Management",
  "HRMS Expense Management",
  "HRMS Salary Management",
  "HRMS Shift Management",
  "HRMS Branch Management",
  "HRMS Departments",
  "HRMS Designations",
];

const buildHrmsPermissions = () => {
  const permissions = {};
  HRMS_FEATURES.forEach((feature) => {
    permissions[feature] = { "View(Global)": true, Create: true, Edit: true, Delete: true };
  });
  return permissions;
};

// Auto-create a default "HRMS" role (full access to HRMS modules only, no
// access to any other feature) so it's available in the Role dropdown
// without the admin having to build it by hand.
const ensureHrmsRole = async (tenant_id) => {
  if (!tenant_id) return;
  const existing = await Role.findOne({ name: "HRMS", tenant_id });
  if (existing) return;
  try {
    await Role.create({
      name: "HRMS",
      tenant_id,
      permissions: buildHrmsPermissions(),
    });
  } catch (error) {
    // Role.name currently carries a legacy global-unique index (not scoped
    // per tenant). If another tenant already claimed "HRMS", skip seeding
    // rather than failing the whole roles list for this request.
    if (error?.code !== 11000) throw error;
  }
};

const getRoles = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    if (req.user?.tenant_id) await ensureHrmsRole(req.user.tenant_id);
    const roles = await Role.find(filter);
    res.json(roles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createRole = async (req, res) => {
  try {
    const role = await Role.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (role) {
      Object.assign(role, req.body);
      const updatedRole = await role.save();
      res.json(updatedRole);
    } else {
      res.status(404).json({ message: "Role not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (role) {
      await role.deleteOne();
      res.json({ message: "Role removed" });
    } else {
      res.status(404).json({ message: "Role not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getRoles, createRole, updateRole, deleteRole };
