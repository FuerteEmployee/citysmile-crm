const mongoose = require("mongoose");
const Reminder = require("../models/Reminder");
const { logActivity } = require("../services/ActivityLogService");
const { syncLeadFollowup } = require("../services/leadInsightsService");

const tenantScope = (req) =>
  !req.user?.is_superadmin
    ? { tenant_id: req.user?.tenant_id ? req.user.tenant_id : new mongoose.Types.ObjectId() }
    : {};

const findOwnTenantReminder = (req) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return null;
  return Reminder.findOne({ _id: req.params.id, ...tenantScope(req) });
};

const afterLeadReminderChange = (reminder) => {
  if (reminder?.rel_type === "lead") {
    syncLeadFollowup(reminder.rel_id).catch((err) =>
      console.error("[Reminders] follow-up sync failed:", err.message)
    );
  }
};

const populate = (q) => q.populate("staff", "firstname lastname").populate("creator", "firstname lastname");

const getReminders = async (req, res) => {
  const { rel_id, rel_type, status } = req.query;
  try {
    const query = { ...tenantScope(req) };
    if (rel_id) query.rel_id = rel_id;
    if (rel_type) query.rel_type = rel_type;
    if (status === "pending") query.status = { $nin: ["completed", "dismissed"] };
    else if (["completed", "dismissed"].includes(status)) query.status = status;

    const reminders = await populate(Reminder.find(query)).sort({ date: 1 });
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createReminder = async (req, res) => {
  try {
    const { description, date, staff, rel_id, rel_type, notify_by_email } = req.body || {};
    if (!description || !String(description).trim()) return res.status(400).json({ message: "A reminder note is required" });
    if (!date || isNaN(new Date(date).getTime())) return res.status(400).json({ message: "A valid follow-up date/time is required" });
    if (!mongoose.Types.ObjectId.isValid(rel_id)) return res.status(400).json({ message: "Invalid rel_id" });

    // A lead reminder must point at a lead in the caller's own tenant.
    if (rel_type === "lead") {
      const Lead = require("../models/Lead");
      const lead = await Lead.exists({ _id: rel_id, ...tenantScope(req) });
      if (!lead) return res.status(404).json({ message: "Lead not found" });
    }

    const reminder = await Reminder.create({
      description: String(description).trim().slice(0, 2000),
      date: new Date(date),
      staff: mongoose.Types.ObjectId.isValid(staff) ? staff : req.user._id,
      rel_id,
      rel_type,
      notify_by_email: !!notify_by_email,
      status: "pending",
      creator: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    if (reminder.rel_type === "lead") {
      logActivity(req, `Set a reminder: ${reminder.description}`, { rel_id: reminder.rel_id, rel_type: "lead" });
    }
    afterLeadReminderChange(reminder);
    res.status(201).json(reminder);
  } catch (error) {
    if (error.name === "ValidationError") return res.status(400).json({ message: error.message });
    res.status(500).json({ message: error.message });
  }
};

const updateReminder = async (req, res) => {
  try {
    const reminder = await findOwnTenantReminder(req);
    if (!reminder) return res.status(404).json({ message: "Reminder not found" });

    const { description, date, staff, notify_by_email } = req.body || {};
    if (description !== undefined) {
      if (!String(description).trim()) return res.status(400).json({ message: "A reminder note is required" });
      reminder.description = String(description).trim().slice(0, 2000);
    }
    if (date !== undefined) {
      if (isNaN(new Date(date).getTime())) return res.status(400).json({ message: "A valid follow-up date/time is required" });
      reminder.date = new Date(date);
      // A rescheduled reminder is live again.
      reminder.isnotified = false;
      if (reminder.status !== "pending") reminder.status = "pending";
    }
    if (staff !== undefined && mongoose.Types.ObjectId.isValid(staff)) reminder.staff = staff;
    if (notify_by_email !== undefined) reminder.notify_by_email = !!notify_by_email;
    await reminder.save();

    if (reminder.rel_type === "lead") {
      logActivity(req, `Updated reminder: ${reminder.description}`, { rel_id: reminder.rel_id, rel_type: "lead" });
    }
    afterLeadReminderChange(reminder);
    res.json(await populate(Reminder.findById(reminder._id)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PATCH /:id/complete | /:id/dismiss | /:id/reopen
const setReminderStatus = (status) => async (req, res) => {
  try {
    const reminder = await findOwnTenantReminder(req);
    if (!reminder) return res.status(404).json({ message: "Reminder not found" });

    reminder.status = status;
    if (status === "pending") {
      reminder.completed_at = undefined;
      reminder.completed_by = undefined;
    } else {
      reminder.completed_at = new Date();
      reminder.completed_by = req.user._id;
      // Prevent the delivery cron from firing a reminder that's already done.
      reminder.isnotified = true;
    }
    if (req.body?.outcome_note !== undefined) reminder.outcome_note = String(req.body.outcome_note).slice(0, 2000);
    await reminder.save();

    if (reminder.rel_type === "lead") {
      const verb = status === "completed" ? "Completed" : status === "dismissed" ? "Dismissed" : "Reopened";
      logActivity(req, `${verb} reminder: ${reminder.description}`, { rel_id: reminder.rel_id, rel_type: "lead" });
    }
    afterLeadReminderChange(reminder);
    res.json(await populate(Reminder.findById(reminder._id)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteReminder = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: "Reminder not found" });
    const reminder = await Reminder.findOneAndDelete({ _id: req.params.id, ...tenantScope(req) });
    if (!reminder) {
      return res.status(404).json({ message: "Reminder not found" });
    }
    afterLeadReminderChange(reminder);
    res.json({ message: "Reminder removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  completeReminder: setReminderStatus("completed"),
  dismissReminder: setReminderStatus("dismissed"),
  reopenReminder: setReminderStatus("pending"),
};
