// Leads Module UI Test Stack
// In-memory MongoDB -> Backend on 127.0.0.1:5101 (built on src/__tests__/leads/leadsStack.cjs)
// NEVER touches the live database, NEVER touches :5001 or :5183, never calls the real Meta Graph API.
//
// Run:  cd "D:\CRM ALL\Backend" && node src/testUtils/startLeadsTestStack.js
//
// Test-only helper endpoints (all under /api/__test or /api/auth on this stack only):
//   POST /api/auth/login      { email }                 -> { token, user, permissions, plan_modules }  (no password: test stack only)
//   GET  /api/auth/me                                   -> real auth_controller.getMe
//   GET  /api/__test/guard                              -> { mongoUri, graphCalls, realFacebookCalls, blockedExternal, emails }
//   GET  /api/__test/info                               -> seeded ids (tenants, users, statuses, sources, leads)
//   POST /api/__test/features { tenant: "A"|"B", keys } -> toggles Tenant.enabled_features (lead add-ons)
//   POST /api/__test/leads-delay { ms }                 -> artificial delay on GET /api/leads (loading skeleton check)
//   GET  /api/__test/requests                           -> recent API requests seen by this stack (method + path + status)
//   GET  /api/__test/404s                               -> API paths that returned 404 (to find missing shell endpoints)

const path = require("path");
const stack = require(path.join(__dirname, "..", "__tests__", "leads", "leadsStack.cjs"));

const PORT = 5101;
const state = { leadsDelayMs: 0, requests: [], notFound: new Map(), seeded: null };

function beforeRoutes(app) {
  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const Staff = require("../models/Staff");
  const { protect } = require("../middleware/auth");
  const { getMe } = require("../controllers/auth_controller");

  // Request log + 404 detector (runs for every request; logs after the response finishes).
  app.use((req, res, next) => {
    res.on("finish", () => {
      if (!req.originalUrl.startsWith("/api/")) return;
      const p = req.originalUrl.split("?")[0];
      state.requests.push({ m: req.method, p, s: res.statusCode, t: Date.now() });
      if (state.requests.length > 3000) state.requests.splice(0, 1000);
      if (res.statusCode === 404 && !p.startsWith("/api/leads/")) {
        state.notFound.set(`${req.method} ${p}`, (state.notFound.get(`${req.method} ${p}`) || 0) + 1);
      }
    });
    next();
  });

  // ---- test-only helpers ----
  app.get("/api/__test/info", (req, res) => res.json(state.seeded || {}));
  app.get("/api/__test/requests", (req, res) => res.json(state.requests));
  app.get("/api/__test/404s", (req, res) => res.json(Object.fromEntries(state.notFound)));
  app.post("/api/__test/features", require("express").json(), async (req, res) => {
    const { tenant = "A", keys = [] } = req.body || {};
    const t = state.seeded?.[tenant];
    if (!t) return res.status(400).json({ message: "unknown tenant" });
    await stack.setFeatures(t.tenantId, keys);
    res.json({ tenant, keys });
  });
  app.post("/api/__test/leads-delay", require("express").json(), (req, res) => {
    state.leadsDelayMs = Math.max(0, Number(req.body?.ms) || 0);
    res.json({ ms: state.leadsDelayMs });
  });
  app.use("/api/leads", (req, res, next) => {
    if (req.method === "GET" && req.path === "/" && state.leadsDelayMs) return setTimeout(next, state.leadsDelayMs);
    next();
  });

  // ---- auth helpers (test stack only; no password check) ----
  app.post("/api/auth/login", require("express").json(), async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const staff = await Staff.findOne({ email });
    if (!staff) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET, { expiresIn: "10h" });
    // Re-use the real getMe so the user/permissions shape is exactly what the app expects.
    const fakeReq = { user: staff, userRole: "staff" };
    const out = await new Promise((resolve) => {
      const fakeRes = { status() { return fakeRes; }, json: resolve };
      getMe(fakeReq, fakeRes);
    });
    res.json({ token, ...out });
  });
  app.get("/api/auth/me", protect, getMe);
  app.post("/api/auth/refresh", (req, res) => res.status(401).json({ code: "REFRESH_INVALID", message: "test stack: no refresh" }));
  app.post("/api/auth/logout", (req, res) => res.json({ message: "Logged out" }));

  // ---- harmless app-shell stubs (minimal JSON, only on this stack) ----
  const ok = (body) => (req, res) => res.json(body);
  app.get("/api/notifications", ok([]));
  app.get("/api/notifications/unread-count", ok({ count: 0 }));
  app.get("/api/todos", ok([]));
  app.get("/api/bookmarks", ok([]));
  app.get("/api/announcements", ok([]));
  app.get("/api/announcements/active", ok([]));
  app.get("/api/modules", ok([]));
  app.get("/api/chat/unread-count", ok({ count: 0 }));
  app.get("/api/chat/unread", ok({ count: 0 }));
  app.get("/api/pwa-manifest", ok({}));
  app.get("/api/hrms/notifications", ok({ data: [] }));
  app.get("/api/hrms/notifications/unread-count", ok({ count: 0 }));
  app.get("/api/whatsapp-integration", ok({}));
  app.get("/api/whatsapp/integration", ok({}));
  app.get("/api/chat/staff", ok([]));
  app.get("/api/meetings", ok([]));
  app.get("/api/quotation-types", ok([]));

  // A bare socket.io server on the same port so NotificationContext's socket connects
  // locally (no polling 404 noise). It never emits anything.
  const origListen = app.listen.bind(app);
  app.listen = (...args) => {
    const srv = origListen(...args);
    const { Server } = require("socket.io");
    new Server(srv, { cors: { origin: true, credentials: true } });
    return srv;
  };

  void mongoose;
}

async function boot() {
  console.log("==================================================================");
  console.log("STARTING LEADS TEST STACK (in-memory Mongo + Backend 127.0.0.1:5101)");
  console.log("==================================================================");

  const { uri, baseUrl } = await stack.start({
    port: PORT,
    beforeRoutes,
    extraRoutes: [
      ["/api/proposals", "routes/proposal_routes"],
      ["/api/currencies", "routes/currency_routes"],
      ["/api/marketing-spend", "routes/marketing_spend_routes"],
      ["/api/mainsidebar", "routes/mainsidebar_routes"],
      ["/api/roles", "routes/role_routes"],
      ["/api/hrms/hrms-branches", "hrms/routes/hrms_branch_route"],
    ],
  });

  const mongoose = require("mongoose");
  console.log(`[GUARD 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: non-memory URI ${uri}`);
  console.log(`[GUARD 1] mongoose host: ${mongoose.connection.host}:${mongoose.connection.port}`);
  if (!baseUrl.endsWith(`:${PORT}`)) throw new Error(`GUARD FAILURE: unexpected base URL ${baseUrl}`);
  console.log(`[GUARD 2] Test backend listening on ${baseUrl} (live :5001 / :5183 not used)`);

  const { A, B } = await stack.seedAll();

  // Extra seed for the UI checks.
  const Role = require("../models/Role");
  const Staff = require("../models/Staff");
  const Currency = require("../models/Currency");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  // A role whose NAME contains "admin" but which only grants Leads View — PermissionContext.can()
  // treats any role name containing admin/owner/super as an admin.
  const salesRole = await Role.create({ name: "Non-Admin Sales", permissions: { Leads: { "View(Global)": true } }, tenant_id: A.tenantId });
  const roleUserId = new mongoose.Types.ObjectId();
  await Staff.create({
    _id: roleUserId, firstname: "RoleSales", lastname: "A", email: "rolesales.a@leads-test.local",
    password: "password123", active: true, tenant_id: A.tenantId, admin: false, role: salesRole._id, permissions: {},
  });
  // Create-only user (no Edit/Delete) for permission checks.
  const createOnlyId = new mongoose.Types.ObjectId();
  await Staff.create({
    _id: createOnlyId, firstname: "createOnly", lastname: "A", email: "createonly.a@leads-test.local",
    password: "password123", active: true, tenant_id: A.tenantId, admin: false,
    permissions: { Leads: { "View(Global)": true, Create: true } },
  });
  await Currency.create([{ name: "INR", symbol: "₹", isdefault: true, is_default: true, tenant_id: A.tenantId }]).catch(() => {});
  await HRMSBranch.create([
    { name: "Ahmedabad Branch", city: "Ahmedabad", tenant_id: A.tenantId },
    { name: "Surat Branch", city: "Surat", tenant_id: A.tenantId },
  ]).catch((e) => console.warn("[seed] branches skipped:", e.message));

  const pick = (c) => ({
    tenantId: String(c.tenantId),
    users: Object.fromEntries(Object.entries(c.users).map(([k, u]) => [k, { id: String(u.id), email: u.email }])),
    statuses: Object.fromEntries(Object.entries(c.statuses).map(([k, v]) => [k, String(v)])),
    sources: Object.fromEntries(Object.entries(c.sources).map(([k, v]) => [k, String(v)])),
    leads: c.leads.map(String),
    requiredFieldId: String(c.requiredField._id),
  });
  state.seeded = {
    mongoUri: uri, baseUrl,
    A: { ...pick(A), extraUsers: { roleSales: { id: String(roleUserId), email: "rolesales.a@leads-test.local" }, createOnly: { id: String(createOnlyId), email: "createonly.a@leads-test.local" } } },
    B: pick(B),
  };
  // Keep live Tenant ObjectIds for setFeatures.
  state.seeded.A.tenantId = A.tenantId;
  state.seeded.B.tenantId = B.tenantId;

  console.log("[SEED] Tenant A:", String(A.tenantId), "| Tenant B:", String(B.tenantId));
  console.log("[SEED] A admin:", A.users.admin.email, "| viewOnly:", A.users.viewOnly.email, "| full:", A.users.full.email, "| pilot:", A.users.pilot.email);
  console.log("[SEED] A role user (Non-Admin Sales, Leads View only): rolesales.a@leads-test.local");
  console.log("[SEED] A lead[0]:", String(A.leads[0]), "| B lead[0]:", String(B.leads[0]));
  console.log(`[READY] ${baseUrl}  (guard: ${baseUrl}/api/__test/guard)`);
  console.log("==================================================================");
}

const shutdown = async () => {
  try { await stack.stop(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (require.main === module) {
  boot().catch((err) => {
    console.error("Failed to start Leads Test Stack:", err);
    process.exit(1);
  });
}

module.exports = { boot };
