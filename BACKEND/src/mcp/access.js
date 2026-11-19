const Staff = require("../models/Staff");
const Setting = require("../models/Setting");
const { hasCapability } = require("../middleware/auth");
const { getTenantBlock } = require("../utils/tenantAccess");
const { loadModuleAccess, isAllowed } = require("../middleware/planModules");

// Modules the Claude connector exposes, with the CRM permission (Setup >
// Roles feature name) and SaaS-plan module each one needs.
//
// Deliberately narrower than the in-app CRM Agent registry
// (config/assistantModules.js):
// - only tenant-scoped modules, so one company can never reach another's rows
//   (Contact, Estimate Request, Email Template and Ticket Pipe Log are not
//   tenant-scoped and are left out);
// - anything that moves money, or Staff (logins), is read-only through Claude.
//   Those records still get created in the CRM itself.
//
// caps overrides the capability checked for an action, for features whose
// role screen has no Create/Edit switch (Meetings only has View).
const MCP_MODULES = {
  lead: { perm: "Leads", plan: ["leads"], write: true },
  client: { perm: "Customers", plan: null, write: true },
  task: { perm: "Tasks", plan: ["tasks"], write: true },
  project: { perm: "Projects", plan: ["projects"], write: true },
  ticket: { perm: "Support", plan: ["support"], write: true },
  expense: { perm: "Expenses", plan: ["expenses"], write: true },
  meeting: { perm: "Meetings", plan: ["meetings"], write: true, caps: { create: "View(Global)", edit: "View(Global)" } },
  milestone: { perm: "Projects", plan: ["projects"], write: false },
  invoice: { perm: "Invoices", plan: ["finance"], write: false },
  creditnote: { perm: "Credit Notes", plan: ["finance"], write: false },
  payment: { perm: "Payments", plan: ["finance"], write: false },
  estimate: { perm: "Estimates", plan: ["estimates"], write: false },
  proposal: { perm: "Proposals", plan: ["proposals"], write: false },
  quotation: { perm: "Quotations", plan: ["sales"], write: false },
  purchase: { perm: "Purchases", plan: ["sales"], write: false },
  vendor: { perm: "Vendors", plan: ["sales"], write: false },
  contract: { perm: "Contracts", plan: ["contracts"], write: false },
  subscription: { perm: "Subscriptions", plan: ["subscriptions"], write: false },
  item: { perm: "Items", plan: ["finance", "estimates", "proposals", "sales"], write: false },
  goal: { perm: "Goals", plan: ["goals"], write: false },
  announcement: { perm: "Announcements", plan: ["announcements"], write: false },
  kbarticle: { perm: "Knowledge Base", plan: ["knowledge_base"], write: false },
  staff: { perm: "Staff", plan: null, write: false },
  marketingspend: { perm: "Leads", plan: ["leads"], write: false },
  reminder: { perm: "Utilities", plan: ["utility"], write: true, caps: { create: "View(Global)", edit: "View(Global)" } },
  todo: { perm: "Utilities", plan: ["utility"], write: true, caps: { create: "View(Global)", edit: "View(Global)" } },
  note: { perm: "Utilities", plan: ["utility"], write: true, caps: { create: "View(Global)", edit: "View(Global)" } },
  calendarevent: { perm: "Calendar", plan: ["calendar"], write: true, caps: { create: "View(Global)", edit: "View(Global)" } },
  timeentry: { perm: "Time Tracking", plan: ["time_tracking"], write: false },
  leadsource: { perm: "Leads", plan: ["leads"], write: false },
  leadstatus: { perm: "Leads", plan: ["leads"], write: false },
  expensecategory: { perm: "Expenses", plan: ["expenses"], write: false },
};

const DEFAULT_CAPS = { read: "View(Global)", create: "Create", edit: "Edit", delete: "Delete" };

// Numbers get_analytics can return, and what each one reveals.
const ANALYTICS_ACCESS = {
  revenue: { perm: "Payments", plan: ["finance"] },
  invoiced: { perm: "Invoices", plan: ["finance"] },
  outstanding: { perm: "Invoices", plan: ["finance"] },
  expenses: { perm: "Expenses", plan: ["expenses"] },
  ad_spend: { perm: "Leads", plan: ["leads"] },
  counts: { perm: "Reports", plan: ["reports"] },
};

// A company admin turns the connector on in Settings (claudeConnectorEnabled).
// Off by default, and switching it off cuts every live Claude connection on
// the next request.
const isConnectorEnabled = async (tenantId) => {
  if (!tenantId) return false;
  const row = await Setting.findOne({ name: "claudeConnectorEnabled", tenant_id: tenantId }).select("value").lean();
  return row?.value === true || row?.value === "true";
};

/**
 * Loads the staff member behind a Claude token and checks they may still use
 * the connector. Returns { user } or { error } (a message safe to show).
 */
const loadConnectorUser = async (staffId) => {
  const user = await Staff.findById(staffId).select("-password");
  if (!user || user.active === false) return { error: "This CRM account is no longer active." };
  // Super admins see every company's data (tenantFilter returns {} for them),
  // which a chat connector must never expose.
  if (user.is_superadmin) return { error: "Super admin accounts can't use the Claude connector." };
  if (!user.tenant_id) return { error: "This account isn't linked to a company." };
  const block = await getTenantBlock(user.tenant_id);
  if (block) return { error: block.message };
  if (!(await isConnectorEnabled(user.tenant_id))) {
    return { error: "Your company admin has switched off the Claude connector in CRM Settings." };
  }
  return { user };
};

const planAllows = async (req, planKeys) => {
  if (!planKeys) return true;
  const access = await loadModuleAccess(req.user.tenant_id);
  return isAllowed(access, planKeys);
};

/**
 * Returns null when the caller may perform `action` ("read" | "create" |
 * "edit" | "delete") on `moduleKey`, otherwise the reason as a message.
 * Reads need View(Global): the CRM's "View (Own)" rules differ per module and
 * the generic tools can't apply them, so own-only users are told to use the
 * CRM instead of being shown everyone's records.
 */
const checkModuleAccess = async (req, moduleKey, action) => {
  const policy = MCP_MODULES[moduleKey];
  if (!policy) return `The "${moduleKey}" module isn't available through Claude.`;
  if (!(await planAllows(req, policy.plan))) return `${policy.perm} isn't included in your company's plan.`;
  if (action !== "read" && !policy.write) {
    return `${policy.perm} is read-only through Claude. Please make this change in the CRM itself.`;
  }

  const caps = { ...DEFAULT_CAPS, ...(policy.caps || {}) };
  if (!(await hasCapability(req, policy.perm, caps.read))) {
    if (await hasCapability(req, policy.perm, "View (Own)")) {
      return `You can only see your own ${policy.perm} records, which Claude can't filter. Please use the CRM for ${policy.perm}.`;
    }
    return `Permission denied: you don't have View permission for ${policy.perm}.`;
  }
  if (action !== "read" && !(await hasCapability(req, policy.perm, caps[action]))) {
    return `Permission denied: you don't have ${caps[action]} permission for ${policy.perm}.`;
  }
  return null;
};

const checkAnalyticsAccess = async (req, metric) => {
  const rule = ANALYTICS_ACCESS[metric];
  if (!rule) return `Unknown metric: ${metric}`;
  if (!(await planAllows(req, rule.plan))) return `${rule.perm} isn't included in your company's plan.`;
  if (!(await hasCapability(req, rule.perm, "View(Global)"))) {
    return `Permission denied: you don't have View permission for ${rule.perm}.`;
  }
  return null;
};

module.exports = {
  MCP_MODULES,
  ANALYTICS_ACCESS,
  isConnectorEnabled,
  loadConnectorUser,
  checkModuleAccess,
  checkAnalyticsAccess,
};
