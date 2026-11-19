const cron = require("node-cron");
const Setting = require("../models/Setting");
const Task = require("../models/Task");
const Ticket = require("../models/Ticket");
const TicketStatus = require("../models/TicketStatus");
const ActivityLog = require("../models/ActivityLog");

// Setup > Settings > Cron Job > Tasks / Tickets. Runs every hour (the CRM's
// own scheduler — no server crontab needed):
//  - Tasks: at the company's "Hour of day", assignees of open tasks whose
//    deadline is within "Task deadline reminder before (Days)" get one
//    in-app notification per task (deadline_notified; reset when the due
//    date changes).
//  - Tickets: "Auto close ticket after (Hours)" closes tickets in "Answered"
//    status whose last reply is older than that (0 = off).

let isRunning = false;
const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";

// Per-company value of each setting (own row, else the global row).
const settingsByTenant = async (names) => {
  const rows = await Setting.find({ name: { $in: names } }).lean();
  const global = {};
  const perTenant = new Map();
  for (const r of rows) {
    if (r.tenant_id == null) global[r.name] = r.value;
    else {
      const key = String(r.tenant_id);
      perTenant.set(key, { ...(perTenant.get(key) || {}), [r.name]: r.value });
    }
  }
  return { global, perTenant };
};

const hourOf = (v) => {
  const n = parseInt(String(v ?? "").split(":")[0], 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 9;
};
const currentHour = (now) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }).format(now));

async function remindTaskDeadlines(io, now = new Date(), { ignoreHour = false } = {}) {
  const { global, perTenant } = await settingsByTenant(["cronTaskHour", "cronTaskDeadlineBefore"]);
  const tenantIds = await Task.distinct("tenant_id", { duedate: { $ne: null }, status: { $ne: 5 }, deadline_notified: { $ne: true } });
  let sent = 0;
  for (const tenantId of tenantIds) {
    const s = { ...global, ...(perTenant.get(String(tenantId)) || {}) };
    const days = parseInt(s.cronTaskDeadlineBefore, 10);
    if (!Number.isFinite(days) || days <= 0) continue;
    if (!ignoreHour && currentHour(now) !== hourOf(s.cronTaskHour)) continue;

    const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const tasks = await Task.find({
      tenant_id: tenantId,
      status: { $ne: 5 },
      deadline_notified: { $ne: true },
      duedate: { $gte: new Date(now.getTime() - 24 * 3600 * 1000), $lte: until },
    }).select("name duedate assignees tenant_id").lean();

    for (const task of tasks) {
      const due = new Date(task.duedate).toLocaleDateString("en-IN", { timeZone: TZ });
      for (const staffId of task.assignees || []) {
        io?.to(String(staffId)).emit("reminderDue", {
          relId: String(task._id),
          relType: "task",
          description: `Task "${task.name}" is due on ${due}`,
          date: task.duedate,
        });
        sent++;
      }
      await ActivityLog.create({
        description: `Deadline reminder sent for task: ${task.name} (due ${due})`,
        tenant_id: task.tenant_id,
        rel_id: task._id,
        rel_type: "task",
        date: now,
      }).catch(() => {});
      await Task.updateOne({ _id: task._id }, { deadline_notified: true });
    }
  }
  return sent;
}

async function autoCloseTickets(now = new Date()) {
  const { global, perTenant } = await settingsByTenant(["cronTicketAutoClose"]);
  const tenantIds = await Ticket.distinct("tenant_id", { status: { $regex: /^answered$/i } });
  let closed = 0;
  for (const tenantId of tenantIds) {
    const s = { ...global, ...(perTenant.get(String(tenantId)) || {}) };
    const hours = parseFloat(s.cronTicketAutoClose);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    // The company's own "Closed" status name, else plain "closed".
    const closedStatus = await TicketStatus.findOne({ name: { $regex: /^closed?$/i }, $or: [{ tenant_id: tenantId }, { tenant_id: null }] })
      .sort({ tenant_id: -1 }).lean().catch(() => null);
    const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
    const res = await Ticket.updateMany(
      { tenant_id: tenantId, status: { $regex: /^answered$/i }, $or: [{ lastreply: { $lt: cutoff } }, { lastreply: null, updatedAt: { $lt: cutoff } }] },
      { status: closedStatus?.name || "closed" }
    );
    closed += res.modifiedCount || 0;
  }
  if (closed) console.log(`[task-ticket-automation] auto-closed ${closed} ticket(s)`);
  return closed;
}

async function tick(io) {
  if (isRunning) return;
  isRunning = true;
  try {
    await remindTaskDeadlines(io);
    await autoCloseTickets();
  } catch (err) {
    console.error("[task-ticket-automation] tick failed:", err.message);
  } finally {
    isRunning = false;
  }
}

function start(io) {
  cron.schedule("2 * * * *", () => tick(io), { timezone: TZ });
}

module.exports = { start, remindTaskDeadlines, autoCloseTickets };
