const ActivityLog = require("../models/ActivityLog");

const getLogs = async (req, res) => {
  try {
    const { rel_id, rel_type } = req.query;
    const logFilter = {};
    if (rel_id) logFilter.rel_id = rel_id;
    if (rel_type) logFilter.rel_type = rel_type;
    if (!req.user?.is_superadmin && req.user?.tenant_id) logFilter.tenant_id = req.user.tenant_id;
    const logs = await ActivityLog.find(logFilter)
      .populate("staffid", "firstname lastname")
      .sort({ date: -1 })
      // NOTE: client-side search only ever sees these 500 rows — a real fix would need
      // server-side search+pagination here, same pattern as lead_controller.js
      .limit(500);

    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLog = async (req, res) => {
  try {
    const log = await ActivityLog.create({
      ...req.body,
      staffid: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(log);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLog = async (req, res) => {
  try {
    const log = await ActivityLog.findByIdAndDelete(req.params.id);
    if (!log) return res.status(404).json({ message: "Activity Log not found" });
    res.json({ message: "Activity Log deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getLogs, createLog, deleteLog };
