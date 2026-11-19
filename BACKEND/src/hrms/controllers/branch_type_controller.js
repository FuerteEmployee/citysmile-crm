const BranchType = require("../models/branch_type_model");

exports.createBranchType = async (req, res) => {
  try {
    const body = { ...req.body };
    // Scope to the requester's own tenant — never trust a client-supplied tenant_id
    body.tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    const branchType = new BranchType(body);
    await branchType.save();
    res.status(201).json({ success: true, data: branchType });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A branch type with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllBranchTypes = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({ success: true, data: [] });
    }
    const tenantFilter = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id };
    const branchTypes = await BranchType.find(tenantFilter).sort({ name: 1 });
    res.status(200).json({ success: true, data: branchTypes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getBranchTypeById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const branchType = await BranchType.findOne({ _id: req.params.id, ...tenantFilter });
    if (!branchType) return res.status(404).json({ success: false, message: "Branch type not found" });
    res.status(200).json({ success: true, data: branchType });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateBranchType = async (req, res) => {
  try {
    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const branchType = await BranchType.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true });
    if (!branchType) return res.status(404).json({ success: false, message: "Branch type not found" });
    res.status(200).json({ success: true, data: branchType });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A branch type with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteBranchType = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const branchType = await BranchType.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!branchType) return res.status(404).json({ success: false, message: "Branch type not found" });
    res.status(200).json({ success: true, message: "Branch type deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

