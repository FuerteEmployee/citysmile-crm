const CalendarEvent = require("../models/CalendarEvent");

exports.createEvent = async (req, res) => {
  try {
    const newEvent = new CalendarEvent({
      ...req.body,
      created_by: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    await newEvent.save();
    res.status(201).json(newEvent);
  } catch (error) {
    res.status(500).json({ message: "Error creating event", error: error.message });
  }
};

exports.getEvents = async (req, res) => {
  try {
    // Return events created by user OR public events, scoped to tenant
    const filter = { $or: [{ created_by: req.user._id }, { isPublic: true }] };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const events = await CalendarEvent.find(filter).sort({ start: 1 });
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ message: "Error fetching events", error: error.message });
  }
};

exports.updateEvent = async (req, res) => {
  try {
    const updatedEvent = await CalendarEvent.findOneAndUpdate(
      { _id: req.params.id, created_by: req.user._id },
      req.body,
      { new: true }
    );
    if (!updatedEvent) return res.status(404).json({ message: "Not found or not authorized" });
    res.status(200).json(updatedEvent);
  } catch (error) {
    res.status(500).json({ message: "Error updating event", error: error.message });
  }
};

exports.deleteEvent = async (req, res) => {
  try {
    const deletedEvent = await CalendarEvent.findOneAndDelete({
      _id: req.params.id,
      created_by: req.user._id,
    });
    if (!deletedEvent) return res.status(404).json({ message: "Not found or not authorized" });
    res.status(200).json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting event", error: error.message });
  }
};

// ── Calendar feed: Setup > Settings > Calendar ─────────────────────────────
// Invoice/estimate/proposal/contract/project/task dates and reminders shown
// on the calendar next to the user's own events. Each module only appears
// when the setting is on AND the user may view that module.
const { readSettings, isOn } = require("../utils/tenantSettings");
const { hasCapability } = require("../middleware/auth");

const CAL_KEYS = [
  "calInvoices", "calEstimates", "calProposals", "calContracts", "calProjects", "calTasks", "calShowOnlyAssignedTasks",
  "calInvoiceColor", "calEstimateColor", "calProposalColor", "calContractColor", "calProjectColor", "calReminderColor",
  "calHideNotifiedReminders", "calCustomerReminders", "calLeadReminders", "calEstimateReminders", "calInvoiceReminders",
  "calProposalReminders", "calTaskReminders", "calTicketReminders", "calExpenseReminders", "calCreditNoteReminders",
];
const REMINDER_TYPES = {
  calCustomerReminders: "customer", calLeadReminders: "lead", calEstimateReminders: "estimate", calInvoiceReminders: "invoice",
  calProposalReminders: "proposal", calTaskReminders: "task", calTicketReminders: "ticket", calExpenseReminders: "expense",
  calCreditNoteReminders: "credit_note",
};
const color = (v, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(v || "")) ? v : fallback);

// "global" / "own" / null for the user's View permission on a module.
const viewLevel = async (req, module) => {
  if (req.user?.admin || req.user?.is_superadmin) return "global";
  if (await hasCapability(req, module, "View(Global)")) return "global";
  if (await hasCapability(req, module, "View (Own)")) return "own";
  return null;
};

exports.getFeed = async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id;
    const s = await readSettings(tenantId, CAL_KEYS);
    const from = req.query.start ? new Date(req.query.start) : new Date(Date.now() - 45 * 864e5);
    const to = req.query.end ? new Date(req.query.end) : new Date(Date.now() + 45 * 864e5);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ message: "Invalid start/end date" });
    const scope = !req.user?.is_superadmin && tenantId ? { tenant_id: tenantId } : {};
    const me = req.user._id;
    const range = (field) => ({ [field]: { $gte: from, $lte: to } });
    const items = [];
    const push = (type, doc, date, title, colorValue, link) =>
      items.push({ _id: `${type}-${doc._id}`, type, title, start: date, end: date, color: colorValue, link, allDay: true, readOnly: true });

    if (isOn(s.calInvoices)) {
      const lvl = await viewLevel(req, "Invoices");
      if (lvl) {
        const docs = await require("../models/Invoice").find({ ...scope, ...range("duedate"), ...(lvl === "own" ? { created_by: me } : {}) }).select("number duedate").limit(500).lean();
        docs.forEach((d) => push("invoice", d, d.duedate, `Invoice ${d.number} due`, color(s.calInvoiceColor, "#ef4444"), `/admin/invoices`));
      }
    }
    if (isOn(s.calEstimates)) {
      const lvl = await viewLevel(req, "Estimates");
      if (lvl) {
        const own = lvl === "own" ? { $or: [{ created_by: me }, { sale_agent: String(me) }] } : {};
        const docs = await require("../models/Estimate").find({ ...scope, ...range("expirydate"), ...own }).select("number expirydate").limit(500).lean();
        docs.forEach((d) => push("estimate", d, d.expirydate, `Estimate ${d.number} expires`, color(s.calEstimateColor, "#f59e0b"), `/admin/estimates`));
      }
    }
    if (isOn(s.calProposals)) {
      const lvl = await viewLevel(req, "Proposals");
      if (lvl) {
        const own = lvl === "own" ? { $or: [{ created_by: me }, { assigned: String(me) }] } : {};
        const docs = await require("../models/Proposal").find({ ...scope, ...range("open_till"), ...own }).select("number subject open_till").limit(500).lean();
        docs.forEach((d) => push("proposal", d, d.open_till, `Proposal ${d.number || d.subject} open till`, color(s.calProposalColor, "#8b5cf6"), `/admin/proposals`));
      }
    }
    if (isOn(s.calContracts)) {
      const lvl = await viewLevel(req, "Contracts");
      if (lvl) {
        const docs = await require("../models/Contract").find({ ...scope, ...range("dateend"), ...(lvl === "own" ? { created_by: me } : {}) }).select("subject dateend").limit(500).lean();
        docs.forEach((d) => push("contract", d, d.dateend, `Contract ends: ${d.subject}`, color(s.calContractColor, "#64748b"), `/admin/contracts`));
      }
    }
    if (isOn(s.calProjects)) {
      const lvl = await viewLevel(req, "Projects");
      if (lvl === "global") {
        const docs = await require("../models/Project").find({ ...scope, ...range("deadline") }).select("name deadline").limit(500).lean();
        docs.forEach((d) => push("project", d, d.deadline, `Project deadline: ${d.name}`, color(s.calProjectColor, "#10b981"), `/admin/projects/${d._id}`));
      }
    }
    if (isOn(s.calTasks)) {
      const lvl = await viewLevel(req, "Tasks");
      if (lvl) {
        const mine = lvl === "own" || isOn(s.calShowOnlyAssignedTasks)
          ? { $or: [{ assignees: me }, { followers: me }, { created_by: me }] }
          : {};
        const docs = await require("../models/Task").find({ ...scope, ...range("duedate"), status: { $ne: 5 }, ...mine }).select("name duedate").limit(500).lean();
        docs.forEach((d) => push("task", d, d.duedate, `Task due: ${d.name}`, "#3b82f6", `/admin/tasks`));
      }
    }
    const reminderTypes = Object.entries(REMINDER_TYPES).filter(([k]) => isOn(s[k])).map(([, t]) => t);
    if (reminderTypes.length) {
      const q = { ...scope, ...range("date"), rel_type: { $in: reminderTypes }, staff: me };
      if (isOn(s.calHideNotifiedReminders)) q.isnotified = { $ne: true };
      const docs = await require("../models/Reminder").find(q).select("description date rel_type").limit(500).lean();
      docs.forEach((d) => items.push({
        _id: `reminder-${d._id}`, type: "reminder", title: `Reminder: ${d.description || d.rel_type}`,
        start: d.date, end: d.date, color: color(s.calReminderColor, "#0ea5e9"), allDay: false, readOnly: true,
      }));
    }
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: "Error loading calendar feed", error: error.message });
  }
};
