const Designation = require("../models/designation_model");
const User = require("../models/user_model");
const { checkNumber } = require("../utils/fieldRules");

const levelError = (body) => checkNumber("Level", body.level, { min: 1, max: 100, integer: true });

exports.createDesignation = async (req, res) => {
  try {
    const invalid = levelError(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const designation = new Designation({
      ...req.body,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await designation.save();
    res.status(201).json({ success: true, data: designation });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A designation with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllDesignations = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const designations = await Designation.find(tenantFilter).populate("departmentId", "name");
    res.status(200).json({ success: true, data: designations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDesignationById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const designation = await Designation.findOne({ _id: req.params.id, ...tenantFilter }).populate("departmentId", "name");
    if (!designation) return res.status(404).json({ success: false, message: "Designation not found" });
    res.status(200).json({ success: true, data: designation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateDesignation = async (req, res) => {
  try {
    const invalid = levelError(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint
    const designation = await Designation.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true });
    if (!designation) return res.status(404).json({ success: false, message: "Designation not found" });
    res.status(200).json({ success: true, data: designation });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A designation with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteDesignation = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const inUse = await User.countDocuments({ designation: req.params.id, ...tenantFilter });
    if (inUse) {
      return res.status(400).json({ success: false, message: `This designation is assigned to ${inUse} staff member(s). Move them to another designation first.` });
    }
    const designation = await Designation.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!designation) return res.status(404).json({ success: false, message: "Designation not found" });
    res.status(200).json({ success: true, message: "Designation deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
