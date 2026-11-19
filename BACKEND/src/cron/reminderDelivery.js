const cron = require("node-cron");
const Reminder = require("../models/Reminder");
const ActivityLog = require("../models/ActivityLog");
const Lead = require("../models/Lead");
const LeadStatus = require("../models/LeadStatus");

// Delivers both Lead and Customer reminders. Checked before widening from
// lead-only to both: zero overdue/unnotified Customer reminders existed in
// the DB at the time, so there's no backlog-flood risk turning both on
// together. If that's no longer true when reading this later, back-fill
// old rows to isnotified=true (without notifying) before widening further.
const REL_TYPES = ["lead", "customer"];

let isRunning = false;

// When a Lead's reminder fires, nudge it into "Pending" so it doesn't get
// lost — but never reopen a lead that's already Complete, and never invent
// a "Pending" status for a tenant that doesn't have one defined.
async function maybeMarkLeadPending(reminder) {
  if (reminder.rel_type !== "lead" || !reminder.rel_id) return;
  try {
    const lead = await Lead.findById(reminder.rel_id).populate("status");
    if (!lead) return;

    const currentStatusName = (lead.status?.name || "").trim().toLowerCase();
    if (currentStatusName === "complete") return;
    // A converted patient (or a confirmed booking) must not be pushed back
    // into "Pending" just because a follow-up reminder fired.
    if (lead.converted || /^(converted|customer)$/.test(currentStatusName) || /^confirm/.test(currentStatusName)) return;

    const pendingStatus = await LeadStatus.findOne({
      name: { $regex: /^pending$/i },
      $or: [{ tenant_id: lead.tenant_id }, { tenant_id: null }],
    }).sort({ tenant_id: -1 }); // tenant-specific "Pending" wins over a global one if both exist
    if (!pendingStatus) return;
    if (String(lead.status?._id) === String(pendingStatus._id)) return; // already pending

    lead.status = pendingStatus._id;
    await lead.save();

    await ActivityLog.create({
      description: `Lead status changed to "${pendingStatus.name}" (reminder fired)`,
      staffid: reminder.staff?._id,
      tenant_id: reminder.tenant_id,
      rel_id: lead._id,
      rel_type: "lead",
      date: new Date(),
    }).catch((err) => console.error("[ReminderDelivery] activity log failed:", err.message));
  } catch (err) {
    console.error("[ReminderDelivery] failed to update lead status:", err.message);
  }
}

async function processDueReminders(io) {
  if (isRunning) return; // don't let a slow tick overlap the next one
  isRunning = true;
  try {
    const dueReminders = await Reminder.find({
      rel_type: { $in: REL_TYPES },
      isnotified: false,
      status: { $nin: ["completed", "dismissed"] },
      date: { $lte: new Date() },
    }).populate("staff", "firstname lastname email");

    for (const reminder of dueReminders) {
      const staffId = reminder.staff?._id?.toString();
      if (!staffId) {
        // No valid assignee to notify — mark it done so it doesn't get
        // retried forever, but don't pretend anyone was actually notified.
        reminder.isnotified = true;
        await reminder.save();
        continue;
      }

      io.to(staffId).emit("reminderDue", {
        reminderId: reminder._id.toString(),
        relId: reminder.rel_id?.toString(),
        relType: reminder.rel_type,
        description: reminder.description,
        date: reminder.date,
      });

      await ActivityLog.create({
        description: `Reminder notification sent: ${reminder.description}`,
        staffid: reminder.staff._id,
        tenant_id: reminder.tenant_id,
        rel_id: reminder.rel_id,
        rel_type: reminder.rel_type,
        date: new Date(),
      }).catch((err) => console.error("[ReminderDelivery] activity log failed:", err.message));

      await maybeMarkLeadPending(reminder);

      reminder.isnotified = true;
      await reminder.save();
    }
  } catch (err) {
    console.error("[ReminderDelivery] tick failed:", err.message);
  } finally {
    isRunning = false;
  }
}

function start(io) {
  const expr = process.env.LEAD_REMINDER_CRON || "*/1 * * * *";
  if (!cron.validate(expr)) {
    console.error(`[ReminderDelivery] Invalid cron expression "${expr}" — not scheduled.`);
    return;
  }
  cron.schedule(expr, () => {
    processDueReminders(io);
  });
  console.log(`[ReminderDelivery] scheduled at "${expr}".`);
}

module.exports = { start, processDueReminders };
