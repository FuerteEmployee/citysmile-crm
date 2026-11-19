const ActivityLog = require("../models/ActivityLog");

/**
 * Records an activity log entry for the currently authenticated staff/admin.
 * Never throws — a logging failure must not break the request that triggered it.
 *
 * @param {import("express").Request} req - the request whose req.user attributes the entry
 * @param {string} description - human-readable summary, e.g. "Created lead: Acme Corp"
 * @param {{ rel_id?: string, rel_type?: string }} [options]
 */
const logActivity = async (req, description, options = {}) => {
  try {
    await ActivityLog.create({
      description,
      staffid: req.user?._id,
      tenant_id: req.user?.tenant_id,
      rel_id: options.rel_id,
      rel_type: options.rel_type,
      date: new Date(),
    });
  } catch (error) {
    console.error("[ActivityLogService] Failed to record activity:", error.message);
  }
};

module.exports = { logActivity };
