// Header (top navbar) Test Stack — test-prompts/02-header.md
// In-memory MongoDB -> Backend on 127.0.0.1:5202 (frontend: vite.config.test.header.ts on :5302).
// NEVER touches the live database (MONGO_URI is overwritten before any app module loads and the
// real .env is never read), NEVER touches :5001 / :5183 or any other agent's ports.
//
// Seeds: tenant Alpha, tenant Beta, tenant Rudraverse (owner info@trinetratechnoworld.com),
// tenant NoPlan (plan with the header's modules switched off) + one super admin.
// Every login's password is "Test@1234".
//
//   node src/testUtils/startHeaderTestStack.js          -> listens on 127.0.0.1:5202
//   require("./startHeaderTestStack").boot({ port: 0 }) -> used by the jest suites

const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const http = require("http");

const PASSWORD = "Test@1234";
const DEFAULT_PORT = 5202;
const FRONTEND_ORIGINS = ["http://127.0.0.1:5302", "http://localhost:5302"];
const FORBIDDEN_PORTS = [5001, 5183, 5101, 5173, 5201, 5203, 5204, 5205, 5206, 5207, 5208];

// Header modules (permission name -> plan module key) the tests care about.
const HEADER_FEATURES = [
  "Estimates", "Proposals", "Customers", "Tasks", "Expenses", "Goals", "Support", "Calendar",
  "Estimate Request", "Chat", "Meetings", "Leads", "Invoices", "Settings", "Bookmarks", "Vendors",
  "Purchases", "Projects", "Contracts", "Reports", "Items", "Payments", "Knowledge Base", "Media",
  "Subscriptions", "Credit Notes", "Announcements",
];
const FULL = { "View(Global)": true, "View (Own)": true, Create: true, Edit: true, Delete: true };
const VIEW_GLOBAL = { "View(Global)": true };
const VIEW_OWN = { "View (Own)": true };
const perms = (caps) => Object.fromEntries(HEADER_FEATURES.map((f) => [f, caps]));

// Routes mounted exactly like index.js (only those that load without external services).
const ROUTES = [
  ["/api/auth", "routes/auth_routes"],
  ["/api/estimate-request-forms", "routes/estimate_request_form_routes"],
  ["/api/estimate-requests", "routes/estimate_request_routes"],
  ["/api/estimate-statuses", "routes/estimate_status_routes"],
  ["/api/chat", "routes/chat_routes"],
  ["/api/meetings", "routes/meeting_routes"],
  ["/api/settings", "routes/setting_routes"],
  ["/api/mainsidebar", "routes/mainsidebar_routes"],
  ["/api/staff", "routes/staff_routes"],
  ["/api/roles", "routes/role_routes"],
  ["/api/tasks", "routes/task_routes"],
  ["/api/time-entries", "routes/time_entry_routes"],
  ["/api/goals", "routes/goal_routes"],
  ["/api/clients", "routes/client_routes"],
  ["/api/currencies", "routes/currency_routes"],
  ["/api/quotations", "routes/quotation_routes"],
  ["/api/quotation-types", "routes/quotation_type_routes"],
  ["/api/purchase-orders", "routes/purchase_order_routes"],
  ["/api/todos", "routes/todo_routes"],
  ["/api/announcements", "routes/announcement_routes"],
  ["/api/modules", "routes/module_routes"],
  ["/api/bookmarks", "routes/bookmark_routes"],
  ["/api/reminders", "routes/reminder_routes"],
  ["/api/calendar-events", "routes/calendar_event_routes"],
  ["/api/custom-fields", "routes/custom_field_routes"],
  ["/api/public", "routes/public_routes"],
  ["/api/pwa-manifest", "routes/pwa_manifest_routes"],
  ["/api/hrms", "hrms/routes/index"],
];

async function seed() {
  const Staff = require("../models/Staff");
  const Tenant = require("../models/Tenant");
  const Role = require("../models/Role");
  const SaasPlan = require("../models/SaasPlan");
  const EstimateRequestForm = require("../models/EstimateRequestForm");

  const fullPlan = await SaasPlan.create({ name: "Header Full Plan", price: 0 });
  const offPlan = await SaasPlan.create({
    name: "Header Modules Off Plan", price: 0,
    module_access: { tasks: false, estimates: false, proposals: false, expenses: false, goals: false, support: false, calendar: false, estimate_request: false, time_tracking: false, chat: false, meetings: false },
  });

  const T = {};
  const mkTenant = async (key, label, ownerEmail, plan) => {
    const tenant = await Tenant.create({ company_name: label, status: "active", plan_id: plan._id });
    const lower = key.toLowerCase();
    const role = async (name, p) => Role.create({ name: `${name} ${key}`, permissions: p, tenant_id: tenant._id });
    const rFull = await role("Full", perms(FULL));
    const rView = await role("ViewGlobal", perms(VIEW_GLOBAL));
    const rOwn = await role("ViewOwn", perms(VIEW_OWN));
    const rNone = await role("NoAccess", {});
    // Bug 19 check: role literally named "Admin" (unique role names -> suffix only for non-Alpha)
    const rAdminLabel = await Role.create({ name: key === "Alpha" ? "Admin" : `Admin ${key}`, permissions: perms(VIEW_GLOBAL), tenant_id: tenant._id });
    const mk = (kind, extra) => Staff.create({
      firstname: kind, lastname: key, email: `${kind.toLowerCase()}.${lower}@header-test.local`, password: PASSWORD,
      active: true, admin: false, tenant_id: tenant._id, ...extra,
    });
    const admin = await Staff.create({ firstname: "Admin", lastname: key, email: ownerEmail, password: PASSWORD, active: true, admin: true, tenant_id: tenant._id });
    await Tenant.updateOne({ _id: tenant._id }, { owner_id: admin._id });
    const users = {
      admin,
      full: await mk("Full", { role: rFull._id }),
      viewGlobal: await mk("ViewGlobal", { role: rView._id }),
      viewOwn: await mk("ViewOwn", { role: rOwn._id }),
      noAccess: await mk("NoAccess", { role: rNone._id }),
      staffAdmin: await mk("StaffAdmin", { role: rAdminLabel._id, admin: true }),
    };
    const forms = await EstimateRequestForm.create([
      { name: `${label} Quote Form`, tenant_id: tenant._id, fields: [{ type: "text", label: "Name" }] },
      { name: `${label} <img src=x onerror=alert(1)>`, tenant_id: tenant._id, fields: [{ type: "text", label: "Name" }] },
    ]);
    T[key] = { key, label, tenantId: tenant._id, tenant, users, forms };
  };

  await mkTenant("Alpha", "Alpha Traders", "admin.alpha@header-test.local", fullPlan);
  await mkTenant("Beta", "Beta Works", "admin.beta@header-test.local", fullPlan);
  await mkTenant("Rudraverse", "Rudraverse", "info@trinetratechnoworld.com", fullPlan);
  await mkTenant("NoPlan", "NoPlan Co", "admin.noplan@header-test.local", offPlan);

  // A legacy form saved before tenant scoping (no tenant_id) — must NOT show to every company.
  await EstimateRequestForm.collection.insertOne({ name: "Legacy untenanted form", fields: [{ type: "text", label: "Name" }], createdAt: new Date(), updatedAt: new Date() });

  const superAdmin = await Staff.create({ firstname: "Super", lastname: "Admin", email: "super@header-test.local", password: PASSWORD, active: true, admin: true, is_superadmin: true, tenant_id: T.Alpha.tenantId });

  return { T, superAdmin };
}

async function boot({ port = DEFAULT_PORT, log = true } = {}) {
  if (FORBIDDEN_PORTS.includes(Number(port))) throw new Error(`GUARD FAILURE: port ${port} belongs to someone else`);
  const say = (...a) => log && console.log(...a);
  say("==================================================================");
  say(`STARTING HEADER TEST STACK (In-memory DB + Backend :${port})`);
  say("==================================================================");

  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-header-test-secret";
  process.env.NODE_ENV = "test";
  delete process.env.JWT_REFRESH_SECRET;
  delete process.env.JOB_SECRET;

  say(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  say(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const { T, superAdmin } = await seed();

  const app = express();
  app.use(cors({ origin: FRONTEND_ORIGINS, credentials: true }));
  app.use(require("cookie-parser")());
  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.use(express.json({ limit: "10mb" }));
  if (log) app.use((req, res, next) => { if (!req.originalUrl.startsWith("/socket.io")) console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });

  const mounted = [];
  const skipped = [];
  for (const [mount, mod] of ROUTES) {
    try { app.use(mount, require(`../${mod}`)); mounted.push(mount); } catch (e) { skipped.push(`${mount} (${e.message.split("\n")[0]})`); }
  }
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port }));
  // Test-only helper: push a notification event to a socket room (used for the 100-notification
  // performance check and the goal / reminder / approval notification sources).
  app.post("/api/__header_test/emit", (req, res) => {
    const { room, event, payload, times = 1 } = req.body || {};
    for (let i = 0; i < Number(times); i++) app.get("io").to(String(room)).emit(event, typeof payload === "object" ? { ...payload, i } : payload);
    res.json({ ok: true });
  });
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Header test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  const server = http.createServer(app);
  const { Server } = require("socket.io");
  const io = new Server(server, { cors: { origin: FRONTEND_ORIGINS, credentials: true } });
  app.set("io", io);
  // Same join handler as index.js:712-716 (copied verbatim — index.js cannot be required in a test
  // because it connects to the real DB and starts crons).
  io.on("connection", (socket) => {
    socket.on("join", (userId) => {
      socket.join(userId);
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = server.address().port;
  say(`[GUARD CHECK 2] Test backend running at http://127.0.0.1:${actualPort}`);
  say("[GUARD CHECK 3] Live ports :5001 and :5183 are NOT used.");
  say(`[ROUTES] mounted: ${mounted.join(", ")}`);
  if (skipped.length) say(`[ROUTES] skipped (failed to load): ${skipped.join("; ")}`);
  for (const t of Object.values(T)) say(`[LOGIN] ${t.key}: admin ${t.users.admin.email}, staff full.${t.key.toLowerCase()}@header-test.local … password ${PASSWORD}`);
  say("==================================================================");

  const stop = async () => {
    io.close();
    await new Promise((r) => server.close(() => r()));
    await mongoose.disconnect();
    await mongod.stop();
  };
  return { mongod, server, io, app, T, superAdmin, port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}`, stop, mounted, skipped };
}

if (require.main === module) {
  boot().then((s) => {
    const shutdown = async () => { await s.stop(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((err) => { console.error("Failed to start Header Test Stack:", err); process.exit(1); });
}

module.exports = { boot, PASSWORD, HEADER_FEATURES };
