const ConsentPurpose = require("../models/ConsentPurpose");

exports.getPurposes = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const purposes = await ConsentPurpose.find(filter).sort({ createdAt: -1 });
    res.json(purposes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createPurpose = async (req, res) => {
  try {
    const purpose = await ConsentPurpose.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(purpose);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.updatePurpose = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const updated = await ConsentPurpose.findOneAndUpdate(filter, req.body, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: "Purpose not found" });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deletePurpose = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const deleted = await ConsentPurpose.findOneAndDelete(filter);
    if (!deleted) return res.status(404).json({ message: "Purpose not found" });
    res.json({ message: "Purpose deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
