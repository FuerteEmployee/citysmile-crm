const Setting = require("../models/Setting");

// Tenant-scoped feature flags stored as Setting rows ({ name, tenant_id }).
// Global Setting rows (tenant_id: null) are defaults; a per-tenant row overrides them.
// Falls back to `false` for tenants with no row at all, so new features stay
// invisible everywhere until explicitly turned on for a tenant.
async function isFeatureEnabled(tenantId, name) {
  if (!tenantId) return false;
  const setting = await Setting.findOne({ name, tenant_id: tenantId });
  if (!setting) return false;
  return setting.value === true || setting.value === "true";
}

module.exports = { isFeatureEnabled };
