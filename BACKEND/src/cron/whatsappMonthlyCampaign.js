const cron = require("node-cron");
const WhatsAppCampaign = require("../models/WhatsAppCampaign");
const { runCampaign } = require("../controllers/whatsapp_campaign_controller");
const { getTenantBlock } = require("../utils/tenantAccess");

let isRunning = false;

// Fires every recurring campaign that's due (put back to "Scheduled" — not
// "Completed" — after each clean run by processCampaignMessages, so it keeps
// firing on this same cron tick every month). Mirrors reminderDelivery.js's
// isRunning guard so a slow month never overlaps the next tick.
async function sendDueRecurringCampaigns() {
  if (isRunning) return;
  isRunning = true;
  try {
    const campaigns = await WhatsAppCampaign.find({
      recurring: true,
      status: "Scheduled",
      template_id: { $ne: null },
    });
    let triggered = 0;
    for (const campaign of campaigns) {
      // Suspended companies (or ones on an inactive plan) get nothing sent;
      // one failing campaign never stops the rest.
      try {
        if (await getTenantBlock(campaign.tenant_id)) continue;
        await runCampaign(campaign);
        triggered += 1;
      } catch (err) {
        console.error(`[WA Monthly Campaign] campaign ${campaign._id} failed:`, err.message);
      }
    }
    console.log(`[WA Monthly Campaign] triggered ${triggered} of ${campaigns.length} recurring campaign(s)`);
  } catch (err) {
    console.error("[WA Monthly Campaign] tick failed:", err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  const expr = process.env.WA_MONTHLY_CRON || "0 10 1 * *";
  if (!cron.validate(expr)) {
    console.error(`[WA Monthly Campaign] Invalid cron expression "${expr}" — not scheduled.`);
    return;
  }
  cron.schedule(expr, sendDueRecurringCampaigns, { timezone: process.env.TZ || "Asia/Kolkata" });
  console.log(`[WA Monthly Campaign] scheduled at "${expr}".`);
}

module.exports = { start, sendDueRecurringCampaigns };
