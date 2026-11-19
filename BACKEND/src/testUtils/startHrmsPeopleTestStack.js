// HRMS People (Part A) + Branches (Part E) Test Stack
// In-memory MongoDB -> Backend on 127.0.0.1:5206 (frontend: vite.config.test.hrms-people.ts on :5306).
// NEVER touches the live database (MONGO_URI is overwritten with the in-memory URI before any
// app module loads, .env is never read), NEVER touches :5001 / :5183 or other agents' ports.
//
// Run:  node src/testUtils/startHrmsPeopleTestStack.js            (UI stack, stays up)
//       HRMS_PEOPLE_PERF=1 node src/testUtils/startHrmsPeopleTestStack.js   (+1,000 staff in company A)
// Export boot({ port, quiet }) so jest can start the same app (port 5206 by default).
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const PORT = 5206;
const FRONT = 5306;

const ROUTES = [
  ["/api/auth", "../routes/auth_routes"],
  ["/api/staff", "../routes/staff_routes"],
  ["/api/roles", "../routes/role_routes"],
  ["/api/settings", "../routes/setting_routes"],
  ["/api/mainsidebar", "../routes/mainsidebar_routes"],
  ["/api/modules", "../routes/module_routes"],
  ["/api/quotation-types", "../routes/quotation_type_routes"],
  ["/api/clients", "../routes/client_routes"],
  ["/api/items", "../routes/item_routes"],
  ["/api/vendors", "../routes/vendor_routes"],
  ["/api/todos", "../routes/todo_routes"],
  ["/api/reminders", "../routes/reminder_routes"],
  ["/api/hrms", "../hrms/routes/index"],
];

async function boot({ port = PORT, quiet = false, perf = !!process.env.HRMS_PEOPLE_PERF } = {}) {
  const log = quiet ? () => {} : console.log;
  log("==================================================================");
  log(`STARTING HRMS PEOPLE TEST STACK (In-memory DB + Backend :${port})`);
  log("==================================================================");

  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-hrms-people-test-secret";
  process.env.PORT = String(port);
  process.env.NODE_ENV = "test";
  delete process.env.JOB_SECRET;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.PLAN_LIMITS_ENFORCE;

  log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const app = express();
  app.use(cors({ origin: [`http://127.0.0.1:${FRONT}`, `http://localhost:${FRONT}`], credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  if (!quiet) app.use((req, res, next) => { if (req.path.startsWith("/api/")) console.log(`[REQ] ${req.method} host=${req.headers.host} ${req.originalUrl}`); next(); });
  app.use("/api", require("../middleware/planModules").planModuleGate);

  const Staff = require("../models/Staff");
  // Test-only login (no password / 2FA): returns the same shape as /api/auth/login.
  app.post("/api/test-login", async (req, res) => {
    const staff = await Staff.findOne({ email: String(req.body?.email || "").trim().toLowerCase() }).populate("role").populate({ path: "tenant_id", populate: { path: "plan_id" } }).lean();
    if (!staff) return res.status(401).json({ message: "Unknown test user" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET);
    const tenant = staff.tenant_id || null;
    const rolePerms = staff.role?.permissions || {};
    const permissions = { ...rolePerms, ...(staff.permissions || {}) };
    res.json({
      token, refreshToken: token,
      user: { _id: staff._id, firstname: staff.firstname, lastname: staff.lastname, email: staff.email, phonenumber: staff.phonenumber, admin: staff.admin, is_superadmin: staff.is_superadmin, is_hrms_staff: staff.is_hrms_staff, role: staff.role?._id || null, tenant },
      permissions, plan_modules: tenant?.plan_id?.module_access || null,
    });
  });
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port }));

  for (const [mount, mod] of ROUTES) {
    try { app.use(mount, require(mod)); } catch (err) { log(`[ROUTE SKIPPED] ${mount}: ${err.message}`); }
  }
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in HRMS People test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  const { seedPeople, seedBulkStaff } = require("./hrms-people.seed");
  const seed = await seedPeople();
  if (perf) log(`[PERF] seeded ${await seedBulkStaff(seed.T.A.tenantId, 1000)} extra staff into company A`);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  log(`[GUARD CHECK 2] Test backend at http://127.0.0.1:${port}`);
  log("[GUARD CHECK 3] Live ports :5001 / :5183 are NOT used.");
  for (const t of Object.values(seed.T)) log(`[LOGIN] ${t.label}: ${Object.values(t.users).map((u) => u.email).join(", ")} — password Test@1234`);
  log("==================================================================");

  const stop = async () => {
    await new Promise((r) => server.close(r));
    await mongoose.disconnect();
    await mongod.stop();
  };
  return { app, server, mongod, uri, seed, stop, baseUrl: `http://127.0.0.1:${port}` };
}

if (require.main === module) {
  boot().then(({ stop }) => {
    const bye = async () => { await stop().catch(() => {}); process.exit(0); };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  }).catch((err) => { console.error("Failed to start HRMS People Test Stack:", err); process.exit(1); });
}

module.exports = { boot, PORT };
