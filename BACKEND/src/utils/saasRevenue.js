// One rule for "estimated monthly revenue" so the Super Admin Dashboard and
// Billing pages always show the same figure (they used to disagree: one
// divided yearly plans by 12, the other didn't, and both counted companies
// whose paid period had already ended).

/** Monthly value of one plan: monthly = price, yearly = price / 12, lifetime = 0. */
const monthlyValue = (plan) => {
  if (!plan) return 0;
  const price = Number(plan.price) || 0;
  if (plan.billing_cycle === "yearly") return price / 12;
  if (plan.billing_cycle === "lifetime") return 0; // one-time, not recurring
  return price;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const cycleDays = (cycle) => (cycle === "yearly" ? 365 : cycle === "lifetime" ? 36500 : 30);
const planOf = (t) => (t?.plan_id && typeof t.plan_id === "object" ? t.plan_id : null);

/**
 * When the company's current trial / paid period ends, or null when it never
 * does (lifetime plan). Same rule as the frontend's lib/tenantExpiry.ts:
 * stored end date first, else start date + plan length.
 */
const periodEnd = (t) => {
  if (!t) return null;
  const plan = planOf(t);
  if (plan?.billing_cycle === "lifetime" && t.status !== "trial") return null;
  const explicit = t.status === "trial" ? t.trial_ends_at : t.billing_cycle_end || t.trial_ends_at;
  if (explicit && !isNaN(new Date(explicit).getTime())) return new Date(explicit);
  const start = t.status === "trial" ? t.createdAt : t.billing_cycle_start || t.createdAt;
  if (!start || isNaN(new Date(start).getTime())) return null;
  const span = t.status === "trial" ? plan?.trial_days ?? 14 : cycleDays(plan?.billing_cycle);
  return new Date(new Date(start).getTime() + span * DAY_MS);
};

/**
 * Status by date: an "active" or "trial" company whose period has ended
 * counts as "expired", even before the expiry job has updated its stored
 * status (cron/tenantExpiry.js only runs for real with TENANT_EXPIRY_DRY_RUN=false).
 */
const effectiveStatus = (t, now = new Date()) => {
  if (!t) return null;
  if (t.status === "active" || t.status === "trial") {
    const end = periodEnd(t);
    if (end && end < now) return "expired";
  }
  return t.status;
};

/** A company currently paying: Active by date, on a plan that costs more than ₹0. */
const isPayingTenant = (tenant, now = new Date()) => {
  if (!tenant || !planOf(tenant)) return false;
  if (effectiveStatus(tenant, now) !== "active") return false;
  return (Number(planOf(tenant).price) || 0) > 0;
};

/** { monthly, payingCount } across the given tenants (plan_id populated with price/billing_cycle). */
const estimateMonthlyRevenue = (tenants, now = new Date()) => {
  const paying = tenants.filter((t) => isPayingTenant(t, now));
  const monthly = paying.reduce((sum, t) => sum + monthlyValue(t.plan_id), 0);
  return { monthly: Math.round(monthly * 100) / 100, payingCount: paying.length };
};

module.exports = { monthlyValue, isPayingTenant, estimateMonthlyRevenue, periodEnd, effectiveStatus };
