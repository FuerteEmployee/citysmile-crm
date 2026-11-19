const cron = require("node-cron");
const Setting = require("../models/Setting");
const ActivityLog = require("../models/ActivityLog");

// Setup > Settings > Misc > "Delete system activity log older then X months".
// Each company's own value wins over the global one; 0 / empty = keep forever.
// Runs nightly.

let isRunning = false;

const monthsOf = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const cutoffFor = (months, now = new Date()) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
};

async function cleanupActivityLogs(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    const rows = await Setting.find({ name: "miscDeleteLogMonths" }).lean();
    const globalMonths = monthsOf(rows.find((r) => r.tenant_id == null)?.value);
    const ownRows = rows.filter((r) => r.tenant_id != null);
    let deleted = 0;

    // Companies with their own value.
    for (const r of ownRows) {
      const months = monthsOf(r.value);
      if (!months) continue;
      const res = await ActivityLog.deleteMany({ tenant_id: r.tenant_id, createdAt: { $lt: cutoffFor(months, now) } });
      deleted += res.deletedCount || 0;
    }
    // Everyone else follows the global value.
    if (globalMonths) {
      const res = await ActivityLog.deleteMany({
        tenant_id: { $nin: ownRows.map((r) => r.tenant_id) },
        createdAt: { $lt: cutoffFor(globalMonths, now) },
      });
      deleted += res.deletedCount || 0;
    }
    if (deleted) console.log(`[activity-log-cleanup] deleted ${deleted} old activity log(s)`);
    return deleted;
  } catch (err) {
    console.error("[activity-log-cleanup] failed:", err.message);
    return 0;
  } finally {
    isRunning = false;
  }
}

function start() {
  cron.schedule("30 2 * * *", () => cleanupActivityLogs(), { timezone: process.env.APP_TIMEZONE || "Asia/Kolkata" });
}

module.exports = { start, cleanupActivityLogs };
