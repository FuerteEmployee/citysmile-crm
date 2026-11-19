// Visibility rules for leads, shared by every lead-related endpoint.
// Staff with only "View (Own)" on Leads (req.permissionLevel === "own", set by
// checkPermission) may only see leads assigned to them, added by them, or
// marked public — not the whole tenant.
const applyOwnScope = (req, query) => {
  if (req.permissionLevel === "own" && req.user?._id) {
    query.$or = [
      { assigned: req.user._id },
      { addedfrom: req.user._id },
      { is_public: true },
    ];
  }
  return query;
};

const tenantFilter = (req) =>
  !req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};

// Base Lead filter for the current user: tenant + own-scope.
const leadScopeFilter = (req) => applyOwnScope(req, { ...tenantFilter(req) });

const isGlobalScope = (req) => req.permissionLevel !== "own";

module.exports = { applyOwnScope, tenantFilter, leadScopeFilter, isGlobalScope };
