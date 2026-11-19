const cron = require("node-cron");
const MetaAdAccount = require("../models/MetaAdAccount");
const { syncTenantSpend } = require("../services/metaAdsService");

// Re-syncs recent days because Meta keeps adjusting the last ~72h of spend.
const SYNC_DAYS = 3;

let isRunning = false;

async function syncAllTenants() {
  if (isRunning) return;
  isRunning = true;
  try {
    const tenantIds = await MetaAdAccount.distinct("tenant_id", { is_active: true });
    for (const tenantId of tenantIds) {
      try {
        const result = await syncTenantSpend(tenantId, { days: SYNC_DAYS });
        if (!result.skipped) {
          console.log(`[MetaAdsSync] tenant=${tenantId} upserted=${result.upserted} removed=${result.removed}`);
        }
      } catch (err) {
        console.error(`[MetaAdsSync] tenant=${tenantId} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[MetaAdsSync] tick failed:", err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  const expr = process.env.META_ADS_SYNC_CRON || "15 */3 * * *";
  if (expr === "off") {
    console.log("[MetaAdsSync] disabled (META_ADS_SYNC_CRON=off).");
    return;
  }
  if (!cron.validate(expr)) {
    console.error(`[MetaAdsSync] Invalid cron expression "${expr}" — not scheduled.`);
    return;
  }
  cron.schedule(expr, syncAllTenants, { timezone: process.env.APP_TIMEZONE || "Asia/Kolkata" });
  console.log(`[MetaAdsSync] scheduled at "${expr}".`);
}

module.exports = { start, syncAllTenants };
