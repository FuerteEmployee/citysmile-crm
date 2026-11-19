// DASHBOARD Module Test Stack
// In-memory MongoDB -> Backend on 127.0.0.1:5201 (frontend: vite.config.test.dashboard.ts on :5301).
// NEVER touches the live database (MONGO_URI is overwritten before any app module loads and the
// real .env is never read), NEVER touches :5001 / :5183 or any other agent's ports.
//
// Run:  node src/testUtils/startDashboardTestStack.js
//
// Test-only helpers (this stack only):
//   POST /api/__test/login        { email }                      -> { token, user, permissions, plan_modules }
//   GET  /api/__test/info                                         -> seeded users/ids/EXPECTED numbers
//   POST /api/__test/plan-module  { tenant, module, on }          -> switch one plan module for that company
//   POST /api/__test/plan-reset   { tenant }                      -> back to the full plan
//   GET  /api/__test/invoice-status?number=A-PASTDUE              -> status stored in the DB right now
//   POST /api/__test/bulk         { tenant }                      -> 5,000 invoices + 5,000 leads + 2,000 tasks
//   GET  /api/__test/requests                                     -> recent API requests (method, path, status)
//   GET  /api/__test/guard                                        -> proof of in-memory DB + host list
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const PORT = 5201;
const FRONTEND = ["http://127.0.0.1:5301", "http://localhost:5301"];

// Every route the dashboard and the app shell (sidebar, top bar, notifications...) may call.
const ROUTES = [
  ["/api/staff", "../routes/staff_routes"],
  ["/api/clients", "../routes/client_routes"],
  ["/api/notes", "../routes/note_routes"],
  ["/api/leads", "../routes/lead_routes"],
  ["/api/lead-statuses", "../routes/lead_status_routes"],
  ["/api/lead-sources", "../routes/lead_source_routes"],
  ["/api/projects", "../routes/project_routes"],
  ["/api/tasks", "../routes/task_routes"],
  ["/api/roles", "../routes/role_routes"],
  ["/api/custom-fields", "../routes/custom_field_routes"],
  ["/api/invoices", "../routes/invoice_routes"],
  ["/api/payments", "../routes/payment_routes"],
  ["/api/estimates", "../routes/estimate_routes"],
  ["/api/proposals", "../routes/proposal_routes"],
  ["/api/items", "../routes/item_routes"],
  ["/api/taxes", "../routes/tax_routes"],
  ["/api/tickets", "../routes/ticket_routes"],
  ["/api/todos", "../routes/todo_routes"],
  ["/api/expenses", "../routes/expense_routes"],
  ["/api/activity-logs", "../routes/activity_log_routes"],
  ["/api/announcements", "../routes/announcement_routes"],
  ["/api/settings", "../routes/setting_routes"],
  ["/api/mainsidebar", "../routes/mainsidebar_routes"],
  ["/api/currencies", "../routes/currency_routes"],
  ["/api/modules", "../routes/module_routes"],
  ["/api/reminders", "../routes/reminder_routes"],
  ["/api/quotations", "../routes/quotation_routes"],
  ["/api/quotation-types", "../routes/quotation_type_routes"],
  ["/api/chat", "../routes/chat_routes"],
  ["/api/meetings", "../routes/meeting_routes"],
  ["/api/bookmarks", "../routes/bookmark_routes"],
  ["/api/calendar-events", "../routes/calendar_event_routes"],
  ["/api/assistant", "../routes/assistant_routes"],
  ["/api/subscriptions", "../routes/subscription_routes"],
  ["/api/hrms", "../hrms/routes/index"],
];

const state = { requests: [], seed: null, uri: null, hosts: new Set() };

async function boot() {
  console.log("==================================================================");
  console.log(`STARTING DASHBOARD TEST STACK (In-memory DB + Backend :${PORT})`);
  console.log("==================================================================");

  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  state.uri = uri;
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-dashboard-test-secret";
  process.env.PORT = String(PORT);
  delete process.env.JOB_SECRET;

  console.log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  console.log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const { seedAll, seedBulk } = require("./dashboardSeed");
  state.seed = await seedAll();
  const S = state.seed;

  const app = express();
  app.use(cors({ origin: FRONTEND, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  app.use((req, res, next) => {
    state.hosts.add(req.headers.host);
    res.on("finish", () => {
      if (!req.originalUrl.startsWith("/api/") || req.originalUrl.startsWith("/api/__test")) return;
      state.requests.push({ m: req.method, p: req.originalUrl, s: res.statusCode, t: Date.now() });
      if (state.requests.length > 5000) state.requests.splice(0, 2000);
    });
    next();
  });

  const Staff = require("../models/Staff");
  const Tenant = require("../models/Tenant");
  require("../models/SaasPlan"); // getMe populates tenant.plan_id
  require("../models/Role");
  const { protect } = require("../middleware/auth");
  const { getMe } = require("../controllers/auth_controller");
  const { invalidatePlanModules } = require("../middleware/planModules");
  const jwt = require("jsonwebtoken");
  const tenantOf = (key) => S[key];

  // ---- test-only helpers ----
  app.post("/api/__test/login", async (req, res) => {
    const staff = await Staff.findOne({ email: String(req.body?.email || "").trim().toLowerCase() });
    if (!staff) return res.status(401).json({ message: "Unknown test user" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET, { expiresIn: "10h" });
    const out = await new Promise((resolve) => {
      const fakeRes = { status() { return fakeRes; }, json: resolve };
      getMe({ user: staff, userRole: "staff" }, fakeRes);
    });
    res.json({ token, ...out });
  });
  app.get("/api/__test/info", (req, res) => res.json(S));
  app.get("/api/__test/requests", (req, res) => res.json(state.requests));
  app.post("/api/__test/requests/clear", (req, res) => { state.requests = []; res.json({ ok: true }); });
  app.get("/api/__test/guard", (req, res) => res.json({ uri: state.uri, host: mongoose.connection.host, hosts: [...state.hosts] }));
  app.post("/api/__test/plan-module", async (req, res) => {
    const t = tenantOf(req.body?.tenant);
    if (!t) return res.status(400).json({ message: "unknown tenant" });
    const db = mongoose.connection.db;
    const name = `Dash custom ${req.body.tenant}`;
    let plan = await db.collection("saasplans").findOne({ name });
    if (!plan) {
      const _id = new mongoose.Types.ObjectId();
      await db.collection("saasplans").insertOne({ _id, name, price: 999, billing_cycle: "monthly", module_access: { ...S.ALL_ON }, trial_days: 14 });
      plan = { _id };
    }
    const modules = Array.isArray(req.body.module) ? req.body.module : [req.body.module];
    const set = Object.fromEntries(modules.map((m) => [`module_access.${m}`, !!req.body.on]));
    await db.collection("saasplans").updateOne({ _id: plan._id }, { $set: set });
    await Tenant.updateOne({ _id: t.tenantId }, { $set: { plan_id: plan._id } });
    invalidatePlanModules(t.tenantId);
    res.json({ ok: true, modules, on: !!req.body.on });
  });
  app.post("/api/__test/plan-reset", async (req, res) => {
    const t = tenantOf(req.body?.tenant);
    if (!t) return res.status(400).json({ message: "unknown tenant" });
    const db = mongoose.connection.db;
    await db.collection("saasplans").updateOne({ name: `Dash custom ${req.body.tenant}` }, { $set: { module_access: { ...S.ALL_ON } } });
    await Tenant.updateOne({ _id: t.tenantId }, { $set: { plan_id: S.plans.fullPlan } });
    invalidatePlanModules(t.tenantId);
    res.json({ ok: true });
  });
  app.get("/api/__test/invoice-status", async (req, res) => {
    const doc = await mongoose.connection.db.collection("invoices").findOne({ number: String(req.query.number), tenant_id: S.A.tenantId });
    res.json({ number: req.query.number, status: doc?.status ?? null });
  });
  app.post("/api/__test/bulk", async (req, res) => {
    const t = tenantOf(req.body?.tenant);
    if (!t) return res.status(400).json({ message: "unknown tenant" });
    const started = Date.now();
    await seedBulk(t.tenantId, t.admin.id, req.body?.sizes || {});
    res.json({ ok: true, ms: Date.now() - started });
  });

  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.get("/api/auth/me", protect, getMe);
  app.post("/api/auth/refresh", (req, res) => res.status(401).json({ code: "REFRESH_INVALID", message: "test stack: no refresh" }));
  app.post("/api/auth/logout", (req, res) => res.json({ message: "Logged out" }));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port: PORT }));

  for (const [mount, mod] of ROUTES) {
    try {
      app.use(mount, require(mod));
    } catch (err) {
      console.log(`[ROUTE SKIPPED] ${mount}: ${err.message}`);
    }
  }
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Dashboard test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  const server = await new Promise((resolve) => { const s = app.listen(PORT, "127.0.0.1", () => resolve(s)); });
  console.log(`[GUARD CHECK 2] Test backend running at http://127.0.0.1:${PORT}`);
  console.log("[GUARD CHECK 3] Live ports :5001 / :5183 and other agents' ports are NOT used.");
  console.log(`[LOGIN] A admin ${S.A.admin.email}; staff full/vglobal/vown/none.a@dash-test.local; B ${S.B.admin.email}; Rudraverse ${S.R.admin.email}`);
  console.log("[READY] dashboard stack ready");
  console.log("==================================================================");

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect().catch(() => {});
    await mongod.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { mongod, server, seed: S };
}

if (require.main === module) {
  boot().catch((err) => { console.error("Failed to start Dashboard Test Stack:", err); process.exit(1); });
}

module.exports = { boot, PORT };
