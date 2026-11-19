/**
 * scheduler — deployment-agnostic job registry.
 *
 *  • Self-hosted (nginx/VPS): set ENABLE_CRON=true and this registers an
 *    in-process node-cron job at the admin-configured time (default 09:00 IST).
 *  • Vercel serverless: leave ENABLE_CRON unset and trigger
 *    POST /api/jobs/run/daily-stock-alerts via Vercel Cron (with x-job-secret).
 *
 * The daily run time is read from SystemSettings.stockAlerts.dailyCheckTime so
 * an admin can change it from the UI; call reschedule() after a settings save.
 */
const cron = require("node-cron");
const stockAlertJobs = require("../jobs/stock_alert_jobs");
const stockAlertSettings = require("./stock_alert_settings");
const attendanceJobs = require("../jobs/attendance_jobs");
const erpReminderJobs = require("../jobs/erp_reminder_jobs");
const { generateTodos } = require("./todo_generator");
const marketingJobs = require("./marketing_jobs");

const JOBS = {
  "daily-stock-alerts": stockAlertJobs.runDailyStockAlerts,
  "low-stock-sweep": stockAlertJobs.runLowStockSweep,
  "dead-stock-scan": stockAlertJobs.runDeadStockScan,
  "velocity-scan": stockAlertJobs.runVelocityScan,
  "close-forgotten-punches": attendanceJobs.closeForgottenPunches,
  "attendance-reminders": attendanceJobs.runAttendanceReminders,
  "erp-reminders": erpReminderJobs.runErpReminders,
  "todo-generator": generateTodos,
  "monthly-education": marketingJobs.sendMonthlyEducation,
};

let task = null; // the currently scheduled node-cron task (stock alerts)
let attendanceTask = null; // the fixed-time attendance cleanup task
let reminderTask = null; // the every-minute reminder task
let erpReminderTask = null; // the fixed-time ERP reminder task
let todoTask = null; // Hourly todo generator task
let eduTask = null; // the monthly educational-content WhatsApp task
let enabled = false;

// "HH:MM" → "M H * * *"; falls back to 09:00 on bad input.
const timeToCron = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return "0 9 * * *";
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return `${minute} ${hour} * * *`;
};

const resolveCronExpr = async () => {
  // Explicit env override always wins (ops escape hatch).
  if (process.env.DAILY_ALERT_CRON) return process.env.DAILY_ALERT_CRON;
  try {
    const s = await stockAlertSettings.get();
    return timeToCron(s.dailyCheckTime);
  } catch {
    return "0 9 * * *";
  }
};

const schedule = async () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  const expr = await resolveCronExpr();

  if (!cron.validate(expr)) {
    console.error(`[Scheduler] Invalid cron expression "${expr}" — daily alerts NOT scheduled.`);
    return;
  }

  if (task) {
    task.stop();
    task = null;
  }

  task = cron.schedule(
    expr,
    async () => {
      try {
        await stockAlertJobs.runDailyStockAlerts();
      } catch (e) {
        console.error("[Scheduler] daily-stock-alerts failed:", e.message);
      }
    },
    { timezone: tz }
  );

  console.log(`[Scheduler] daily-stock-alerts scheduled at "${expr}" (${tz}).`);
};

// Fixed time (not admin-configurable, unlike stock alerts) — this is a
// system safety job, not a business setting. 04:00 IST comfortably clears
// any realistic overnight shift ending by the early morning before it
// touches yesterday's still-open attendance records. Override with
// CLOSE_PUNCHES_CRON for a different deployment's needs.
const scheduleAttendanceCleanup = () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  const expr = process.env.CLOSE_PUNCHES_CRON || "0 4 * * *";

  if (!cron.validate(expr)) {
    console.error(`[Scheduler] Invalid cron expression "${expr}" — close-forgotten-punches NOT scheduled.`);
    return;
  }
  if (attendanceTask) {
    attendanceTask.stop();
    attendanceTask = null;
  }
  attendanceTask = cron.schedule(
    expr,
    async () => {
      try {
        await attendanceJobs.closeForgottenPunches();
      } catch (e) {
        console.error("[Scheduler] close-forgotten-punches failed:", e.message);
      }
    },
    { timezone: tz },
  );
  console.log(`[Scheduler] close-forgotten-punches scheduled at "${expr}" (${tz}).`);
};

// Every-minute reminder tick. Cheap: one indexed user query + one attendance
// query per minute, fires push/socket only in the exact due minute.
const scheduleAttendanceReminders = () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
  reminderTask = cron.schedule(
    "* * * * *",
    async () => {
      try {
        await attendanceJobs.runAttendanceReminders();
      } catch (e) {
        console.error("[Scheduler] attendance-reminders failed:", e.message);
      }
    },
    { timezone: tz },
  );
  console.log(`[Scheduler] attendance-reminders scheduled (every minute, ${tz}).`);
};

const scheduleErpReminders = () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  const expr = process.env.ERP_REMINDERS_CRON || "0 8 * * *"; // 8:00 AM daily

  if (!cron.validate(expr)) {
    console.error(`[Scheduler] Invalid cron expression "${expr}" — erp-reminders NOT scheduled.`);
    return;
  }
  if (erpReminderTask) {
    erpReminderTask.stop();
    erpReminderTask = null;
  }
  erpReminderTask = cron.schedule(
    expr,
    async () => {
      try {
        await erpReminderJobs.runErpReminders();
      } catch (e) {
        console.error("[Scheduler] erp-reminders failed:", e.message);
      }
    },
    { timezone: tz },
  );
  console.log(`[Scheduler] erp-reminders scheduled at "${expr}" (${tz}).`);
};

const scheduleTodoGenerator = () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  const expr = process.env.TODO_CRON || "0 * * * *"; // Hourly by default

  if (!cron.validate(expr)) {
    console.error(`[Scheduler] Invalid cron expression "${expr}" — todo-generator NOT scheduled.`);
    return;
  }
  if (todoTask) {
    todoTask.stop();
    todoTask = null;
  }
  todoTask = cron.schedule(
    expr,
    async () => {
      try {
        await generateTodos();
      } catch (e) {
        console.error("[Scheduler] todo-generator failed:", e.message);
      }
    },
    { timezone: tz },
  );
  console.log(`[Scheduler] todo-generator scheduled at "${expr}" (${tz}).`);
};

// Monthly WhatsApp educational-content campaign. Default: 10:00 IST on the 1st
// of each month. Override with MONTHLY_EDU_CRON.
const scheduleMonthlyEducation = () => {
  const tz = process.env.TZ || "Asia/Kolkata";
  const expr = process.env.MONTHLY_EDU_CRON || "0 10 1 * *";

  if (!cron.validate(expr)) {
    console.error(`[Scheduler] Invalid cron expression "${expr}" — monthly-education NOT scheduled.`);
    return;
  }
  if (eduTask) {
    eduTask.stop();
    eduTask = null;
  }
  eduTask = cron.schedule(
    expr,
    async () => {
      try {
        await marketingJobs.sendMonthlyEducation();
      } catch (e) {
        console.error("[Scheduler] monthly-education failed:", e.message);
      }
    },
    { timezone: tz },
  );
  console.log(`[Scheduler] monthly-education scheduled at "${expr}" (${tz}).`);
};

const init = async () => {
  if (String(process.env.ENABLE_CRON) !== "true") {
    console.log(
      "[Scheduler] In-process cron disabled. Set ENABLE_CRON=true (self-hosted) " +
        "or trigger POST /api/jobs/run/daily-stock-alerts, /close-forgotten-punches, /attendance-reminders (serverless / external cron)."
    );
    return;
  }
  enabled = true;
  await schedule();
  scheduleAttendanceCleanup();
  scheduleAttendanceReminders();
  scheduleErpReminders();
  scheduleTodoGenerator();
  scheduleMonthlyEducation();
};

// Re-read settings and re-register the cron (call after admin changes the time).
const reschedule = async () => {
  if (!enabled) return false;
  await schedule();
  return true;
};

const runJob = async (name) => {
  const fn = JOBS[name];
  if (!fn) throw new Error(`Unknown job "${name}". Available: ${Object.keys(JOBS).join(", ")}`);
  return fn();
};

module.exports = { init, reschedule, runJob, JOBS };
