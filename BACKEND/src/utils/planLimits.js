const Tenant = require("../models/Tenant");
const Staff = require("../models/Staff");

// SaaS plan limits (SaasPlan.features). Currently: max_users = how many
// active staff logins a company may have (the owner counts; -1 = unlimited).
//
// Rollout switch, PLAN_LIMITS_ENFORCE in .env:
//   unset / "off"   → never enforced (default, so a deploy changes nothing)
//   "on"            → enforced for every company
//   "<id>,<id>"     → enforced only for these company (tenant) ids, for testing
// Super admins are never limited, and neither is the owner created with a company.

const enforcedFor = (tenantId) => {
  const mode = String(process.env.PLAN_LIMITS_ENFORCE || "off").trim().toLowerCase();
  if (!tenantId || mode === "" || mode === "off" || mode === "false") return false;
  if (mode === "on" || mode === "true") return true;
  return mode.split(",").map((s) => s.trim()).includes(String(tenantId).toLowerCase());
};

const limitMessage = (limit) =>
  `Your plan allows ${limit} team member${limit === 1 ? "" : "s"}. Deactivate a staff member or upgrade your plan to add more.`;

/**
 * Can `adding` more active staff be added to this company?
 * Returns { allowed, limit, used, message }. limit null = no limit.
 */
const checkStaffLimit = async (tenantId, adding = 1) => {
  if (!enforcedFor(tenantId)) return { allowed: true, limit: null, used: null };
  const tenant = await Tenant.findById(tenantId).select("plan_id").populate("plan_id", "features").lean();
  const limit = tenant?.plan_id?.features?.max_users;
  if (typeof limit !== "number" || limit < 0) return { allowed: true, limit: null, used: null };
  const used = await Staff.countDocuments({ tenant_id: tenantId, active: { $ne: false }, is_superadmin: { $ne: true } });
  const allowed = used + adding <= limit;
  return { allowed, limit, used, message: allowed ? undefined : limitMessage(limit) };
};

/**
 * Express helper: sends 403 PLAN_LIMIT_REACHED and returns true when the
 * request would go over the limit. Super admins are skipped.
 */
const rejectIfStaffLimit = async (req, res, tenantId, adding = 1) => {
  if (req.user?.is_superadmin) return false;
  const result = await checkStaffLimit(tenantId, adding);
  if (result.allowed) return false;
  res.status(403).json({ code: "PLAN_LIMIT_REACHED", message: result.message, limit: result.limit, used: result.used });
  return true;
};

module.exports = { checkStaffLimit, rejectIfStaffLimit, enforcedFor };
