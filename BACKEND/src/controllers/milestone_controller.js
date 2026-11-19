const Milestone = require("../models/Milestone");

const getMilestones = async (req, res) => {
  try {
    const query = req.query.project ? { project: req.query.project } : {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;
    const milestones = await Milestone.find(query).sort({ milestone_order: 1 });
    res.json(milestones);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createMilestone = async (req, res) => {
  try {
    const milestone = await Milestone.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(milestone);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getMilestones, createMilestone };
