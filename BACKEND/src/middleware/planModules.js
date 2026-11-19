const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff");
const Tenant = require("../models/Tenant");
const HrmsUser = require("../hrms/models/user_model");

// Enforces SaaS plan module access (SaasPlan.module_access) on the API, so a
// module switched off in the company's plan is blocked server-side, not just
// hidden from the sidebar. Mounted once on "/api" in index.js, before the
// routers; it only identifies the caller from the token itself and leaves
// real authentication to each router's own protect().
//
// Rules, matching the frontend's isModuleEnabled():
//   - super admins always pass
//   - no plan, or a module key missing from the plan = allowed
//   - only an explicit `false` blocks (403 MODULE_DISABLED)
//   - requests without a valid token pass through (public webhooks/forms,
//     or protect() rejects them later)

// [path prefix under /api, module key or list (allowed if ANY is on), options]
// Longest prefix wins. Routes not listed are core and never gated: auth,
// staff, clients, notes, files, media, roles, settings, currencies, todos,
// custom fields, email templates, reminders, assistant, faqs, super-admin...
const ROUTE_MODULES = [
  ["/bookmarks", "bookmarks"],
  ["/kb", "knowledge_base"],
  ["/leads", "leads"],
  ["/lead-pipeline", "leads"],
  ["/lead-sources", "leads"],
  ["/lead-statuses", "leads"],
  ["/marketing-spend", "leads"],
  ["/meta-ads", "leads"],
  ["/meta-integration", "leads"],
  ["/calling-agent", "leads"],
  ["/whatsapp", "whatsapp"],
  ["/whatsapp-integration", "whatsapp"],
  ["/website-lead-forms", "website_forms"],
  ["/projects", "projects"],
  ["/milestones", "projects"],
  ["/tasks", "tasks"],
  ["/invoices", "finance"],
  ["/payments", "finance"],
  ["/credit-notes", "finance"],
  ["/payment-modes", "finance"],
  ["/bank-details", "finance"],
  // Items/taxes are read by invoices, estimates, proposals and quotations.
  ["/items", ["finance", "estimates", "proposals", "sales"]],
  ["/taxes", ["finance", "estimates", "proposals", "sales"]],
  ["/estimates", "estimates"],
  ["/proposals", "proposals"],
  ["/quotations", "sales"],
  // The sidebar reads quotation types for every user; only writes are gated.
  ["/quotation-types", "sales", { readOpen: true }],
  ["/purchases", "sales"],
  ["/vendors", "sales"],
  ["/tickets", "support"],
  ["/departments", "support"],
  ["/priorities", "support"],
  ["/ticket-statuses", "support"],
  ["/services", "support"],
  ["/spam-filters", "support"],
  ["/predefined-replies", "support"],
  ["/contracts", "contracts"],
  ["/contract-types", "contracts"],
  ["/expenses", "expenses"],
  ["/expense-categories", "expenses"],
  ["/subscriptions", "subscriptions"],
  ["/activity-logs", "utility"],
  ["/ticket-pipe-logs", "utility"],
  ["/reports", "reports"],
  ["/chat", "chat"],
  ["/goals", "goals"],
  ["/announcements", "announcements"],
  ["/estimate-request-forms", "estimate_request", { skip: [/^\/public\//] }],
  ["/estimate-requests", "estimate_request"],
  ["/estimate-statuses", "estimate_request"],
  ["/meetings", "meetings"],
  ["/time-entries", "time_tracking"],
  ["/calendar-events", "calendar"],
  // HRMS. Lookups used by CRM screens (Setup > Staff form, sidebar branch
  // scope) stay open; logins/refresh carry no token yet anyway.
  [
    "/hrms",
    "hrms",
    {
      skip: [
        /^\/hrms\/hrms-branches(\/my-scope)?\/?$/,
        /^\/hrms\/(departments|designations|shifts|managing-companies)(\/|$)/,
        /^\/hrms\/(push-status|push-test|setup)(\/|$)/,
        /^\/hrms\/users\/(login|refresh)(\/|$)/,
      ],
    },
  ],
].sort((a, b) => b[0].length - a[0].length);

const findRule = (path) =>
  ROUTE_MODULES.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));

// ── Caches (protect-style lookups on every request) ──
const CACHE_MS = 60 * 1000;
const callerCache = new Map(); // token subject -> { tenantId, superadmin, at }
const planCache = new Map(); // tenantId -> { access, at }

const cached = (map, key) => {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < CACHE_MS ? hit : null;
};

/** Call when a plan's modules or a company's plan changes. */
const invalidatePlanModules = (tenantId) => {
  if (tenantId) planCache.delete(String(tenantId));
  else planCache.clear();
};

const readToken = (req) => {
  if (req.cookies?.token) {
    // Cookie tokens are encrypted; reuse the auth middleware's decryptor.
    const { decryptToken } = require("./auth");
    const t = decryptToken(req.cookies.token);
    if (t) return t;
  }
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.split(" ")[1];
  return null;
};

const resolveCaller = async (decoded) => {
  const key = decoded.userId ? `U:${decoded.userId}` : decoded.id ? `${decoded.role}:${decoded.id}` : null;
  if (!key) return null;
  const hit = cached(callerCache, key);
  if (hit) return hit;

  let caller = null;
  if (decoded.userId) {
    const u = await HrmsUser.findById(decoded.userId).select("tenant_id").lean();
    caller = u ? { tenantId: u.tenant_id || null, superadmin: false } : null;
  } else if (decoded.role === "staff") {
    const s = await Staff.findById(decoded.id).select("tenant_id is_superadmin").lean();
    caller = s ? { tenantId: s.tenant_id || null, superadmin: !!s.is_superadmin } : null;
  }
  // Client-portal contacts and unknown callers aren't plan-gated here.
  if (caller) callerCache.set(key, { ...caller, at: Date.now() });
  return caller;
};

const loadModuleAccess = async (tenantId) => {
  const key = String(tenantId);
  const hit = cached(planCache, key);
  if (hit) return hit.access;
  const tenant = await Tenant.findById(tenantId).select("plan_id").populate("plan_id", "module_access").lean();
  const access = tenant?.plan_id?.module_access || null;
  planCache.set(key, { access, at: Date.now() });
  return access;
};

const isAllowed = (access, keys) => !access || keys.some((k) => access[k] !== false);

const planModuleGate = async (req, res, next) => {
  try {
    if (req.method === "OPTIONS") return next();
    const rule = findRule(req.path);
    if (!rule) return next();
    const [, moduleKey, opts = {}] = rule;
    if (opts.readOpen && req.method === "GET") return next();
    if (opts.skip && opts.skip.some((re) => re.test(req.path.slice(rule[0].length) || "/") || re.test(req.path))) {
      return next();
    }

    const token = readToken(req);
    if (!token) return next();
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next(); // expired/invalid: protect() answers with the right 401
    }

    const caller = await resolveCaller(decoded);
    if (!caller || caller.superadmin || !caller.tenantId) return next();

    const keys = Array.isArray(moduleKey) ? moduleKey : [moduleKey];
    const access = await loadModuleAccess(caller.tenantId);
    if (isAllowed(access, keys)) return next();

    return res.status(403).json({
      code: "MODULE_DISABLED",
      module: keys[0],
      message: "This module is not included in your plan",
    });
  } catch (err) {
    // Never take the API down because of the gate itself.
    console.error("[planModuleGate]", err.message);
    return next();
  }
};

module.exports = { planModuleGate, invalidatePlanModules, ROUTE_MODULES, findRule, isAllowed, loadModuleAccess };
