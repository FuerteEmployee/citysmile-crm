// HRMS Part C + D ("money") test harness.
// In-memory MongoDB only (mongodb-memory-server) + an Express app on 127.0.0.1:5208.
// Guard checks copied from startGoalsTestStack.js: MONGO_URI is overwritten BEFORE any
// app module is loaded, and we refuse to continue unless the connection is 127.0.0.1.
// The real .env is never read (dotenv is never required here).
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");

const PORT = Number(process.env.HRMS_MONEY_PORT || 5208);
const PASSWORD = "Test@1234";
let mongod;
let server;

// Extra routes the dashboard shell calls (only mounted for the browser stack).
const SHELL_ROUTES = [
  ["/api/staff", "../routes/staff_routes"],
  ["/api/roles", "../routes/role_routes"],
  ["/api/settings", "../routes/setting_routes"],
  ["/api/mainsidebar", "../routes/mainsidebar_routes"],
  ["/api/modules", "../routes/module_routes"],
  ["/api/quotation-types", "../routes/quotation_type_routes"],
  ["/api/todos", "../routes/todo_routes"],
  ["/api/reminders", "../routes/reminder_routes"],
  ["/api/currencies", "../routes/currency_routes"],
  ["/api/chat", "../routes/chat_routes"],
  ["/api/meetings", "../routes/meeting_routes"],
  ["/api/activity-logs", "../routes/activity_log_routes"],
];

async function start({ shell = false, port = PORT, log = false } = {}) {
  if ([5001, 5183, 5101, 5173].includes(port) || (port >= 5201 && port <= 5207)) {
    throw new Error(`GUARD FAILURE: port ${port} belongs to live/other agents`);
  }
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "hrms-money-test-secret";
  process.env.JWT_REFRESH_SECRET = "hrms-money-test-refresh";
  process.env.NODE_ENV = "test";
  delete process.env.JOB_SECRET;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  if (log) console.log(`[GUARD CHECK 1 PASSED] in-memory DB ${uri}`);

  // Main-CRM models HRMS populates (index.js registers them in the real server).
  for (const m of ["QuotationType", "Staff", "Tenant", "SaasPlan"]) { try { require(`../models/${m}`); } catch { /* optional */ } }

  const app = express();
  app.use(require("cors")({ origin: ["http://127.0.0.1:5308", "http://localhost:5308"], credentials: true }));
  app.use(require("cookie-parser")());
  app.use(express.json({ limit: "25mb" }));
  if (log) app.use((req, res, next) => { if (req.path.startsWith("/api/")) console.log(`[REQ] ${req.method} host=${req.headers.host} ${req.originalUrl}`); next(); });
  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.use("/api/auth", require("../routes/auth_routes"));
  app.use("/api/hrms", require("../hrms/routes/index"));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port }));
  if (shell) {
    for (const [mount, mod] of SHELL_ROUTES) {
      try { app.use(mount, require(mod)); } catch (err) { console.log(`[ROUTE SKIPPED] ${mount}: ${err.message}`); }
    }
  }
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in HRMS money test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  await new Promise((resolve, reject) => {
    server = app.listen(port, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  if (log) console.log(`[GUARD CHECK 2] backend http://127.0.0.1:${port} (live :5001/:5183 untouched)`);
  return { uri, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
}

const sign = (staffId) => jwt.sign({ id: String(staffId), role: "staff" }, process.env.JWT_SECRET);

// Minimal HTTP client (never throws on 4xx/5xx). path is under /api/hrms unless it starts with /api.
function client(token, port = PORT) {
  const call = async (method, path, body, extraHeaders = {}) => {
    const url = `http://127.0.0.1:${port}${path.startsWith("/api") ? path : `/api/hrms${path}`}`;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const t0 = Date.now();
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, ms: Date.now() - t0 };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, b, h) => call("POST", p, b, h),
    put: (p, b, h) => call("PUT", p, b, h),
    patch: (p, b, h) => call("PATCH", p, b, h),
    del: (p, h) => call("DELETE", p, undefined, h),
  };
}

const HRMS_FEATURE_FOR = {
  view_leaves: "HRMS Leave Management",
  manage_expenses: "HRMS Expense Management",
  view_payroll: "HRMS Salary Management",
  manage_payroll: "HRMS Salary Management",
};

let mobileSeq = 6000000000;

// One company. Every person is BOTH a CRM Staff login (password Test@1234) and an HRMS
// User, linked via Staff.hrms_user_id — the same shape real tenants have.
async function seedTenant(label, { email, hrmsOff = false, hidden = [] } = {}) {
  const db = mongoose.connection.db;
  const Staff = require("../models/Staff");
  const tenantId = new mongoose.Types.ObjectId();
  let planId = null;
  if (hrmsOff) {
    planId = new mongoose.Types.ObjectId();
    await db.collection("saasplans").insertOne({ _id: planId, name: `No HRMS ${label}`, price: 0, module_access: { hrms: false }, createdAt: new Date() });
  }
  await db.collection("tenants").insertOne({ _id: tenantId, company_name: `${label} Test Co`, name: `${label} Test Co`, status: "active", plan_id: planId, hidden_hrms_features: hidden, createdAt: new Date() });

  const T = { label, tenantId, people: {} };
  const roles = {};
  const roleFor = async (perms) => {
    const key = perms.join(",") || "none";
    if (roles[key]) return roles[key];
    const _id = new mongoose.Types.ObjectId();
    const isAdmin = perms.includes("*");
    await db.collection("hrmsroles").insertOne({ _id, role: isAdmin ? "admin" : `r_${key.replace(/[^a-z]/gi, "_").toLowerCase()}`, label: isAdmin ? "Admin" : `Role ${key}`, permissions: perms, tenant_id: tenantId });
    roles[key] = _id;
    return _id;
  };

  // perms = HRMS role permission keys (what the API checks)
  // screenPerms = CRM Staff.permissions map (what the screen checks); defaults to the same feature(s)
  T.addPerson = async (key, { name, perms = [], screenPerms, admin = false, salaryAmount = 0, extra = {} } = {}) => {
    const userId = new mongoose.Types.ObjectId();
    const personEmail = (key === "admin" && email) ? email : `${key}.${label.toLowerCase()}@hrms-money.test`;
    const roleId = await roleFor(admin ? ["*"] : perms);
    await db.collection("users").insertOne({
      _id: userId, name: name || `${key} ${label}`, email: personEmail, password: "x", role: roleId, isActive: true,
      salaryAmount, tenant_id: tenantId, mobile: String(mobileSeq++), weeklyHolidays: [], createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    let sp = screenPerms;
    if (sp === undefined) {
      sp = {};
      for (const p of perms) if (HRMS_FEATURE_FOR[p]) sp[HRMS_FEATURE_FOR[p]] = { "View(Global)": true, Create: true, Edit: true, Delete: true };
    }
    const staff = await Staff.create({ firstname: key, lastname: label, email: personEmail, password: PASSWORD, admin, active: true, tenant_id: tenantId, hrms_user_id: userId, permissions: sp });
    const p = { key, userId: String(userId), staffId: String(staff._id), email: personEmail, token: sign(staff._id) };
    p.api = client(p.token);
    T.people[key] = p;
    return p;
  };

  T.admin = await T.addPerson("admin", { admin: true, name: `Admin ${label}` });
  T.api = T.admin.api;
  return T;
}

// Standard people for Parts C/D in one company.
async function seedStandardPeople(T) {
  const db = mongoose.connection.db;
  T.branch1 = new mongoose.Types.ObjectId();
  T.branch2 = new mongoose.Types.ObjectId();
  await T.addPerson("leavemgr", { perms: ["view_leaves"] });
  await T.addPerson("expmgr", { perms: ["manage_expenses"] });
  await T.addPerson("paymgr", { perms: ["view_payroll", "manage_payroll"] });
  await T.addPerson("emp", { salaryAmount: 30000, extra: { hrmsBranchId: T.branch1 } });
  await T.addPerson("emp2", { salaryAmount: 20000, extra: { hrmsBranchId: T.branch2 } });
  await T.addPerson("sup", { extra: { hrmsBranchId: T.branch1 } });
  // Screen says "Salary Management", HRMS API role has nothing (two permission systems).
  await T.addPerson("desync", { perms: [], screenPerms: { "HRMS Salary Management": { "View(Global)": true } } });
  await db.collection("hrmsbranches").insertMany([
    { _id: T.branch1, name: `Branch One ${T.label}`, tenant_id: T.tenantId, supervisorIds: [new mongoose.Types.ObjectId(T.people.sup.userId)], isActive: true },
    { _id: T.branch2, name: `Branch Two ${T.label}`, tenant_id: T.tenantId, supervisorIds: [], isActive: true },
  ]);
  return T;
}

module.exports = { start, stop, client, sign, seedTenant, seedStandardPeople, PASSWORD, PORT };
