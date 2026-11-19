// Goals Module Test Stack (05-goals.md)
// In-memory MongoDB -> Backend on 127.0.0.1:5101 (frontend: vite.config.test.ts on :5173).
// NEVER touches the live database, NEVER touches :5001 or :5183.
// Seeds the fake test tenants from goalsFixtures (BeOnTime, CitySmile, Kiran, OffixNest,
// Rudraverse, Ekagra + NoGoalsPlan). Every login's password is "Test@1234".

const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");

const PASSWORD = "Test@1234";

async function boot() {
  console.log("==================================================================");
  console.log("STARTING GOALS TEST STACK (In-memory DB + Backend :5101)");
  console.log("==================================================================");

  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-goals-test-secret";
  process.env.PORT = "5101";
  delete process.env.JOB_SECRET;

  console.log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  console.log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const { seedAllTenants } = require("./goalsFixtures");
  const { T, Goal } = await seedAllTenants({ password: PASSWORD });

  // Extra UI rows for BeOnTime: 30 goals total, long text, XSS text, odd progress values,
  // and one goal with no start_date (inserted raw, bypassing the model) for the crash check.
  const bt = T.BeOnTime;
  const day = 864e5;
  const extra = [];
  for (let i = 0; i < 25; i++) {
    extra.push({
      subject: `UI Goal ${String(i + 1).padStart(2, "0")}`, staff_member: bt.pick[i % 3]._id, achievement: String(100 * (i + 1)),
      start_date: new Date(Date.now() - (i % 2 ? 40 : 2) * day), end_date: new Date(Date.now() + (i % 2 ? -5 : 20) * day),
      goal_type: ["total_income", "convert_leads", "invoiced_amount"][i % 3], tenant_id: bt.tenantId, progress: (i * 4) % 101,
    });
  }
  extra.push({ subject: `Long ${"Subject ".repeat(40)}`, description: "Long description ".repeat(300), staff_member: bt.pick[0]._id, achievement: "1", start_date: new Date(), end_date: new Date(Date.now() + day), goal_type: "total_income", tenant_id: bt.tenantId, progress: 150 });
  extra.push({ subject: "XSS goal", description: "<img src=x onerror=\"window.__xss=1\"><script>window.__xss=2</script>", staff_member: bt.pick[1]._id, achievement: "1", start_date: new Date(), end_date: new Date(Date.now() + day), goal_type: "convert_leads", tenant_id: bt.tenantId, progress: -10 });
  // Raw insert: these stand in for older data saved before the length / progress rules.
  await Goal.collection.insertMany(extra.map((g) => ({ ...g, achievement: Number(g.achievement), notify_on_achieve: true, notify_on_fail: true, createdAt: new Date(), updatedAt: new Date() })));

  // Own tenant ("CrashCheck") whose list holds a goal with no start_date (page-crash check),
  // so the crash does not block the normal per-tenant flows.
  const Staff = require("../models/Staff");
  const crashTenant = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection("tenants").insertOne({ _id: crashTenant, company_name: "CrashCheck", status: "active" });
  const crashAdmin = await Staff.create({ firstname: "Admin", lastname: "CrashCheck", email: "admin@crashcheck.test", password: PASSWORD, active: true, admin: true, tenant_id: crashTenant });
  await mongoose.connection.db.collection("goals").insertOne({ subject: "Broken date goal", staff_member: crashAdmin._id, achievement: "5", goal_type: "total_income", tenant_id: crashTenant, progress: 0, createdAt: new Date(), updatedAt: new Date() });

  const app = express();
  app.use(cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173"], credentials: true }));
  app.use(express.json({ limit: "25mb" }));
  app.use((req, res, next) => { console.log(`[REQ] ${req.method} ${req.originalUrl} host=${req.headers.host}`); next(); });

  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.use("/api/auth", require("../routes/auth_routes"));
  app.use("/api/goals", require("../routes/goal_routes"));
  app.use("/api/staff", require("../routes/staff_routes"));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port: 5101 }));
  // Everything else the app shell asks for (sidebar, notifications…) is not part of this stack.
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Goals test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  const server = await new Promise((resolve) => { const s = app.listen(5101, "127.0.0.1", () => resolve(s)); });
  console.log("[GUARD CHECK 2] Test backend running at http://127.0.0.1:5101");
  console.log("[GUARD CHECK 3] Live ports :5001 and :5183 are NOT used.");
  for (const t of Object.values(T)) console.log(`[LOGIN] ${t.key}: admin ${t.email} / viewer viewer.${t.key.toLowerCase()}@crm-test.local — password ${PASSWORD}`);
  console.log("==================================================================");
  return { mongod, server, T };
}

if (require.main === module) {
  boot().catch((err) => { console.error("Failed to start Goals Test Stack:", err); process.exit(1); });
}

module.exports = { boot, PASSWORD };
