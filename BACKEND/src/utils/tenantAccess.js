const Tenant = require("../models/Tenant");
const { singleTenantBlock } = require("./singleTenant");

// Company-level access gate shared by the CRM login/protect and the HRMS
// login/protect: one Suspend switch (Tenant.status "inactive") blocks the CRM,
// the HRMS module inside it and the HRMS mobile app. A company that no longer
// exists is blocked the same way. An Inactive SaaS plan does NOT block anyone:
// it only stops new companies from choosing that plan.
// Expired companies are NOT blocked here — they keep the "Subscription
// Expired" popup on the frontend.

const SUSPENDED_MESSAGE = "Your company account is suspended. Please contact support.";
const NOT_FOUND_MESSAGE = "Your company account no longer exists. Please contact support.";

// protect() runs on every request, so cache each tenant's status briefly.
// invalidateTenantAccess() is called when a super admin changes a status, so
// Suspend / Re-activate take effect immediately on this server.
const CACHE_MS = 60 * 1000;
const cache = new Map();

// Company status, or null when the company is missing.
const loadStatus = async (tenantId) => {
  const key = String(tenantId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const tenant = await Tenant.findById(tenantId).select("status").lean();
  const value = tenant ? tenant.status : null;
  cache.set(key, { value, at: Date.now() });
  return value;
};

const invalidateTenantAccess = (tenantId) => {
  if (tenantId) cache.delete(String(tenantId));
  else cache.clear();
};

/**
 * Returns null when the company may use the software, otherwise
 * { status, code, message } to send back. Accounts without a company
 * (super admins, not-yet-linked owners) are never blocked here.
 */
const getTenantBlock = async (tenantId, { isSuperadmin = false } = {}) => {
  // Single-company server: Super Admins and other companies' accounts are
  // refused at every login and on every request (see utils/singleTenant.js).
  const lockBlock = singleTenantBlock(tenantId, { isSuperadmin });
  if (lockBlock) return lockBlock;
  if (!tenantId) return null;
  const id = tenantId._id || tenantId;
  const status = await loadStatus(id);
  if (status === null) return { status: 401, code: "TENANT_NOT_FOUND", message: NOT_FOUND_MESSAGE };
  if (status === "inactive") return { status: 403, code: "TENANT_SUSPENDED", message: SUSPENDED_MESSAGE };
  return null;
};

/** Sends the block response and returns true when the company is blocked. */
const rejectIfTenantBlocked = async (res, tenantId, opts) => {
  const block = await getTenantBlock(tenantId, opts);
  if (!block) return false;
  res.status(block.status).json({ code: block.code, message: block.message });
  return true;
};

module.exports = { getTenantBlock, rejectIfTenantBlocked, invalidateTenantAccess, SUSPENDED_MESSAGE };
