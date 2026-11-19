const cron = require("node-cron");
const Tenant = require("../models/Tenant");
const { invalidateTenantAccess } = require("../utils/tenantAccess");

// Marks companies "expired" once their plan or trial end date has passed, so
// the Super Admin status counts, the Expired filter and alerts are correct.
// Before this, status only ever changed when a super admin edited it by hand.
//
// Expired companies are not blocked from logging in (they keep the frontend
// "Subscription Expired" popup); only a suspended ("inactive") company is.
//
// Dry run by default: it only logs which companies it WOULD expire, until
// TENANT_EXPIRY_DRY_RUN=false is set in .env (after the user reviewed the list).

const isDryRun = () => String(process.env.TENANT_EXPIRY_DRY_RUN ?? "true").toLowerCase() !== "false";

// Grace period: a company is marked expired only this many days after its
// plan/trial ended (it keeps working and sees a red "renew" banner meanwhile).
// Same default as the frontend's GRACE_DAYS (lib/tenantExpiry.ts).
const graceDays = () => {
  const n = parseInt(process.env.TENANT_GRACE_DAYS ?? "7", 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
};

let isRunning = false;

async function findDueTenants(now = new Date()) {
  const cutoff = new Date(now.getTime() - graceDays() * 24 * 60 * 60 * 1000);
  const tenants = await Tenant.find({
    $or: [
      { status: "active", billing_cycle_end: { $lt: cutoff } },
      { status: "trial", trial_ends_at: { $lt: cutoff } },
    ],
  })
    .populate("plan_id", "billing_cycle")
    .select("company_name status billing_cycle_end trial_ends_at plan_id");
  // Lifetime plans never expire, whatever end date they carry.
  return tenants.filter((t) => !(t.status === "active" && t.plan_id?.billing_cycle === "lifetime"));
}

async function expireDueTenants() {
  if (isRunning) return;
  isRunning = true;
  try {
    const due = await findDueTenants();
    if (due.length === 0) return;

    const label = (t) =>
      `${t.company_name} (${t.status}, ended ${(t.status === "trial" ? t.trial_ends_at : t.billing_cycle_end).toISOString().slice(0, 10)})`;

    if (isDryRun()) {
      console.log(`[tenantExpiry] DRY RUN — would mark ${due.length} company(ies) expired: ${due.map(label).join("; ")}`);
      return;
    }

    for (const t of due) {
      // Re-check the status in the update itself so a renew that lands in
      // between is never overwritten.
      const res = await Tenant.updateOne({ _id: t._id, status: t.status }, { $set: { status: "expired" } });
      if (!res.modifiedCount) continue;
      invalidateTenantAccess(t._id);
      console.log(`[tenantExpiry] marked expired: ${label(t)}`);
    }
  } catch (err) {
    console.error("[tenantExpiry] run failed:", err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  // Daily shortly after midnight, plus once a minute after startup so a
  // server that was down at midnight still catches up.
  cron.schedule("15 0 * * *", expireDueTenants, { timezone: process.env.APP_TIMEZONE || "Asia/Kolkata" });
  setTimeout(expireDueTenants, 60 * 1000);
}

module.exports = { start, expireDueTenants, findDueTenants };
