const EstimateStatus = require("../models/EstimateStatus");

const getEstimateStatuses = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const statuses = await EstimateStatus.find(filter).sort({ statusorder: 1 });
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createEstimateStatus = async (req, res) => {
  try {
    const status = await EstimateStatus.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(status);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "An estimate status with this name already exists." });
    }
    res.status(500).json({ message: error.message });
  }
};

const updateEstimateStatus = async (req, res) => {
  try {
    const status = await EstimateStatus.findById(req.params.id);
    if (status) {
      Object.assign(status, req.body);
      const updatedStatus = await status.save();
      res.json(updatedStatus);
    } else {
      res.status(404).json({ message: "Estimate status not found" });
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "An estimate status with this name already exists." });
    }
    res.status(500).json({ message: error.message });
  }
};

const deleteEstimateStatus = async (req, res) => {
  try {
    const status = await EstimateStatus.findById(req.params.id);
    if (status) {
      await status.deleteOne();
      res.json({ message: "Estimate status removed" });
    } else {
      res.status(404).json({ message: "Estimate status not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getEstimateStatuses,
  createEstimateStatus,
  updateEstimateStatus,
  deleteEstimateStatus,
};
