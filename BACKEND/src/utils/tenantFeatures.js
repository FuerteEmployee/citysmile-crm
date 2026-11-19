const Tenant = require("../models/Tenant");
const { allowedFeatures } = require("../config/tenantFeatures");

// Enabled feature keys for a tenant (empty Set when none / no tenant).
const getTenantFeatures = async (tenantId) => {
  const features = new Set();
  if (!tenantId) return features;

  const tenant = await Tenant.findById(tenantId).select("enabled_features company_name subdomain custom_domains").lean();
  if (!tenant) return features;

  if (tenant.enabled_features) {
    allowedFeatures(tenantId, tenant.enabled_features).forEach((f) => features.add(f));
  }

  return features;
};

const tenantHasFeature = async (tenantId, key) => (await getTenantFeatures(tenantId)).has(key);

// Blocks the route unless the super admin enabled `key` for the caller's
// tenant (or it's Kiran Engineering for procurement_types). Superadmins pass.
const requireTenantFeature = (key) => async (req, res, next) => {
  try {
    if (req.user?.is_superadmin) return next();
    const tenantId = req.user?.tenant_id || req.tenant_id;
    if (await tenantHasFeature(tenantId, key)) return next();
    return res.status(403).json({ code: "FEATURE_DISABLED", message: "This feature is not enabled for your account" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { getTenantFeatures, tenantHasFeature, requireTenantFeature };
