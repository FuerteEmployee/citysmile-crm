const Tenant = require("../models/Tenant");

// This is a single-company server: it holds exactly one company, set by
// TENANT_ID in .env. Super Admins never log in here (the separate Super Admin
// panel manages this server through /api/control), and accounts of any other
// company are refused.

const SUPERADMIN_MESSAGE = "Super Admin access is not allowed on this server.";
const WRONG_COMPANY_MESSAGE = "This account does not belong to this company's CRM.";

const lockedTenantId = () => (process.env.TENANT_ID ? String(process.env.TENANT_ID).trim() : null);

/**
 * Returns null when OK, otherwise { status, code, message }.
 * A missing tenantId is allowed (old records are healed to TENANT_ID elsewhere).
 */
const singleTenantBlock = (tenantId, { isSuperadmin = false } = {}) => {
  if (isSuperadmin) return { status: 403, code: "SUPERADMIN_NOT_ALLOWED", message: SUPERADMIN_MESSAGE };
  const locked = lockedTenantId();
  const id = tenantId && (tenantId._id || tenantId);
  if (locked && id && String(id) !== locked) {
    return { status: 403, code: "WRONG_COMPANY", message: WRONG_COMPANY_MESSAGE };
  }
  return null;
};

/**
 * Startup check: refuse to run unless TENANT_ID is set and this database holds
 * exactly that one company. Prevents a client server from ever being pointed
 * at the shared main database by mistake.
 */
const assertSingleTenantDatabase = async () => {
  const locked = lockedTenantId();
  if (!locked) throw new Error("TENANT_ID is not set in .env (required on a single-company server)");
  const tenants = await Tenant.find().select("_id company_name").limit(5).lean();
  if (tenants.length !== 1 || String(tenants[0]._id) !== locked) {
    const found = tenants.map((t) => `${t._id} (${t.company_name})`).join(", ") || "none";
    throw new Error(`Database must hold exactly one company with id ${locked}; found: ${found}`);
  }
  return tenants[0];
};

module.exports = { lockedTenantId, singleTenantBlock, assertSingleTenantDatabase, SUPERADMIN_MESSAGE, WRONG_COMPANY_MESSAGE };
