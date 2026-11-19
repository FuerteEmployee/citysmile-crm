const Department = require("../models/department_model");
const User = require("../models/user_model");

// An empty string is not a valid ObjectId — treat a blank/"none" manager as no manager.
const normalizeManagerId = (body) => {
  if (!body.managerId || body.managerId === "__none__") {
    body.managerId = null;
  }
  return body;
};

exports.createDepartment = async (req, res) => {
  try {
    const body = normalizeManagerId(req.body);
    const department = new Department({
      ...body,
      tenant_id: req.user?.is_superadmin ? (body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await department.save();
    await department.populate("managerId", "name");
    res.status(201).json({ success: true, data: department });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A department with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllDepartments = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const departments = await Department.find(tenantFilter).populate("managerId", "name");
    res.status(200).json({ success: true, data: departments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDepartmentById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const department = await Department.findOne({ _id: req.params.id, ...tenantFilter }).populate("managerId", "name");
    if (!department) return res.status(404).json({ success: false, message: "Department not found" });
    res.status(200).json({ success: true, data: department });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const body = normalizeManagerId(req.body);
    delete body.tenant_id; // never reassignable via this endpoint
    const department = await Department.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true })
      .populate("managerId", "name");
    if (!department) return res.status(404).json({ success: false, message: "Department not found" });
    res.status(200).json({ success: true, data: department });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A department with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const inUse = await User.countDocuments({ department: req.params.id, ...tenantFilter });
    if (inUse) {
      return res.status(400).json({ success: false, message: `This department has ${inUse} staff member(s). Move them to another department first.` });
    }
    const department = await Department.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!department) return res.status(404).json({ success: false, message: "Department not found" });
    res.status(200).json({ success: true, message: "Department deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
