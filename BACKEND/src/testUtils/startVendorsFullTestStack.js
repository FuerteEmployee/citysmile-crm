// Vendors full test pass stack (test-prompts/06-vendors.md).
// In-memory MongoDB only -> backend on 127.0.0.1:5205 (frontend: vite.config.test.vendors.ts on :5305).
// NEVER reads .env, NEVER touches the live DB, NEVER uses :5001 / :5183 or other agents' ports.
// Every login's password is "Test@1234".
//
// Tenants:
//   Alpha      - plan with sales + hrms on, NO HRMS branches (branch = free text)
//   Beta       - plan with sales + hrms on, HAS HRMS branches but not Rudraverse (suspected bug 12)
//   Rudraverse - owner info@trinetratechnoworld.com, HRMS on, branches Mumbai/Pune
//   NoSales    - plan with module_access.sales = false
// Alpha users: admin, full, viewGlobal, viewOwn, noAccess, createOnly, roleAdmin (role named
// "Vendor Admin Viewer" that only has View(Global)).
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");

const PASSWORD = "Test@1234";
const PORT = Number(process.env.VENDORS_STACK_PORT || 5205);
const FE_ORIGINS = ["http://127.0.0.1:5305", "http://localhost:5305"];

const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };

async function connectMemoryDb() {
  // Throw away anything that may have come from a .env before any app module loads.
  delete process.env.MONGO_URI;
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-vendors-fullpass-secret";
  process.env.JWT_REFRESH_SECRET = "crm-vendors-fullpass-refresh";
  delete process.env.JOB_SECRET;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  return { mongod, uri };
}

const tokenFor = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET);

async function seed() {
  const Staff = require("../models/Staff");
  const SaasPlan = require("../models/SaasPlan");
  const Role = require("../models/Role");
  const Vendor = require("../models/Vendor");
  const Purchase = require("../models/Purchase");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  const db = mongoose.connection.db;
  await Vendor.init(); // build the unique index before tests rely on it

  const fullPlan = await SaasPlan.create({ name: "Vendors Full Plan", price: 0, module_access: { sales: true, hrms: true } });
  const noSalesPlan = await SaasPlan.create({ name: "Vendors No Sales Plan", price: 0, module_access: { sales: false, hrms: true } });
  const roleAdminLike = await Role.create({ name: "Vendor Admin Viewer", permissions: { Vendors: { "View(Global)": true } } });

  const T = {};
  const mkTenant = async (key, adminEmail, plan) => {
    const tenantId = new mongoose.Types.ObjectId();
    await db.collection("tenants").insertOne({ _id: tenantId, company_name: `${key} Co`, status: "active", plan_id: plan._id, createdAt: new Date() });
    const mk = async (first, extra = {}) => {
      const email = first === "Admin" ? adminEmail : `${first}.${key}@crm-test.local`.toLowerCase();
      const s = await Staff.create({ firstname: first, lastname: key, email, password: PASSWORD, active: true, tenant_id: tenantId, ...extra });
      return { id: s._id, email, token: tokenFor(s._id) };
    };
    const t = { key, tenantId, adminEmail };
    t.admin = await mk("Admin", { admin: true });
    t.full = await mk("Full", { permissions: { Vendors: FULL, Purchases: FULL } });
    t.viewGlobal = await mk("ViewGlobal", { permissions: { Vendors: { "View(Global)": true } } });
    t.viewOwn = await mk("ViewOwn", { permissions: { Vendors: { "View (Own)": true, Create: true } } });
    t.noAccess = await mk("NoAccess", { permissions: { Purchases: FULL } });
    T[key] = t;
    return t;
  };

  const A = await mkTenant("Alpha", "admin@alpha.test", fullPlan);
  A.createOnly = await (async () => {
    const s = await Staff.create({ firstname: "CreateOnly", lastname: "Alpha", email: "createonly.alpha@crm-test.local", password: PASSWORD, active: true, tenant_id: A.tenantId, permissions: { Vendors: { "View(Global)": true, Create: true } } });
    return { id: s._id, email: s.email, token: tokenFor(s._id) };
  })();
  A.roleAdmin = await (async () => {
    const s = await Staff.create({ firstname: "RoleAdmin", lastname: "Alpha", email: "roleadmin.alpha@crm-test.local", password: PASSWORD, active: true, tenant_id: A.tenantId, role: roleAdminLike._id });
    return { id: s._id, email: s.email, token: tokenFor(s._id) };
  })();
  const B = await mkTenant("Beta", "admin@beta.test", fullPlan);
  const R = await mkTenant("Rudraverse", "info@trinetratechnoworld.com", fullPlan);
  const N = await mkTenant("NoSales", "admin@nosales.test", noSalesPlan);

  await HRMSBranch.create([
    { name: "Beta North", city: "Surat", tenant_id: B.tenantId, status: "Active" },
    { name: "Beta South", city: "Vadodara", tenant_id: B.tenantId, status: "Active" },
    { name: "Mumbai Branch", city: "Mumbai", tenant_id: R.tenantId, status: "Active" },
    { name: "Pune Branch", city: "Pune", tenant_id: R.tenantId, status: "Active" },
  ]);

  // Alpha vendors: 30 so pagination has 3 pages at 10/page. createdAt spaced so "newest first" is testable.
  const base = Date.now() - 1000 * 60 * 60;
  const alphaDocs = [];
  for (let i = 1; i <= 30; i++) {
    alphaDocs.push({
      company_name: `Alpha Vendor ${String(i).padStart(2, "0")}`,
      vendor_reference: `AV-${i}`,
      connect_person: i % 2 ? "Ramesh Patel" : "Sita Shah",
      phone_number: `98${String(76543200 + i).padStart(8, "0")}`,
      email: `vendor${i}@alpha.test`,
      address: i % 3 ? "CG Road, Ahmedabad, Gujarat" : "MG Road, Pune, Maharashtra",
      sales_person: i % 4 ? "Divya" : "Karan",
      tenant_id: A.tenantId,
      created_by: i <= 3 ? A.viewOwn.id : A.admin.id,
      createdAt: new Date(base + i * 1000),
      updatedAt: new Date(base + i * 1000),
    });
  }
  await Vendor.collection.insertMany(alphaDocs);
  A.kpiVendor = await Vendor.create({
    company_name: "KPI Traders", phone_number: "9123456780", email: "kpi@traders.test",
    pan_number: "ABCDE1234F", gst_number: "24ABCDE1234F1Z5", address: "SG Highway, Ahmedabad", tenant_id: A.tenantId, created_by: A.admin.id,
  });
  await Purchase.create([
    { bill_no: "KPI-1", bill_date: new Date("2026-05-01"), supplier_name: "KPI Traders", vendor_id: A.kpiVendor._id, amount: 1000, cgst: 90, sgst: 90, total: 1180, payment_status: "Paid", tenant_id: A.tenantId },
    { bill_no: "KPI-2", bill_date: new Date("2026-06-01"), supplier_name: "KPI Traders", vendor_id: A.kpiVendor._id, amount: 500, igst: 90, total: 590, payment_status: "Unpaid", tenant_id: A.tenantId },
    { bill_no: "KPI-3", bill_date: new Date("2026-07-01"), supplier_name: "KPI Traders", vendor_id: A.kpiVendor._id, amount: 1000, cgst: 90, sgst: 90, total: 1180, payment_status: "Partially Paid", paid_amount: 1000, amount_paid: 1000, tenant_id: A.tenantId },
  ]);
  // Old bad data (saved before validation existed) - raw insert.
  await Vendor.collection.insertOne({ company_name: "Legacy Bad Phone", phone_number: "12345", pan_number: "BADPAN", tenant_id: A.tenantId, created_by: A.admin.id, createdAt: new Date(base - 5000), updatedAt: new Date(base - 5000) });
  // XSS vendor (raw insert: the API would reject tags) so the UI rendering can be checked.
  await Vendor.collection.insertOne({ company_name: "XSS <img src=x onerror=\"window.__xss=1\">", address: "<script>window.__xss=2</script>", tenant_id: A.tenantId, created_by: A.admin.id, createdAt: new Date(base - 6000), updatedAt: new Date(base - 6000) });

  B.vendors = await Vendor.create([
    { company_name: "Beta Secret Vendor", phone_number: "9988776655", branch: "Beta North", tenant_id: B.tenantId, created_by: B.admin.id },
  ]);
  R.vendors = await Vendor.create([
    { company_name: "Rudra Mumbai Supplier", branch: "Mumbai Branch", tenant_id: R.tenantId, created_by: R.admin.id },
    { company_name: "Rudra Pune Supplier", branch: "Pune Branch", tenant_id: R.tenantId, created_by: R.admin.id },
    { company_name: "Rudra No Branch Supplier", tenant_id: R.tenantId, created_by: R.admin.id },
  ]);
  N.vendors = await Vendor.create([{ company_name: "NoSales Vendor", tenant_id: N.tenantId, created_by: N.admin.id }]);

  // Perf tenant: 10,000 vendors (phase 11).
  const P = await mkTenant("Perf", "admin@perf.test", fullPlan);
  const perfCount = Number(process.env.VENDORS_PERF_COUNT || 10000);
  const perfDocs = [];
  for (let i = 1; i <= perfCount; i++) {
    perfDocs.push({
      company_name: `Perf Vendor ${String(i).padStart(5, "0")}`, vendor_reference: `PV-${i}`, connect_person: `Contact ${i}`,
      phone_number: `9${String(100000000 + i)}`, email: `perf${i}@perf.test`, address: `Plot ${i}, GIDC, Gujarat`,
      sales_person: `Sales ${i % 20}`, account_details: `Bank A/C ${100000000 + i}`, tenant_id: P.tenantId, created_by: P.admin.id,
      createdAt: new Date(base + i), updatedAt: new Date(base + i),
    });
  }
  if (perfDocs.length) await Vendor.collection.insertMany(perfDocs);
  return { T, A, B, R, N, P };
}

function buildApp() {
  // Models the HRMS branch controller populates (normally loaded by index.js).
  require("../models/QuotationType");
  require("../hrms/models/branch_type_model");
  try { require("../hrms/models/user_model"); } catch { /* optional */ }
  const app = express();
  app.use(cors({ origin: FE_ORIGINS, credentials: true }));
  app.use(express.json({ limit: "50mb" }));
  if (process.env.VENDORS_STACK_LOG) app.use((req, res, next) => { console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });
  app.use("/api", require("../middleware/planModules").planModuleGate);
  app.use("/api/auth", require("../routes/auth_routes"));
  app.use("/api/vendors", require("../routes/vendor_routes"));
  app.use("/api/purchases", require("../routes/purchase_routes"));
  app.use("/api/settings", require("../routes/setting_routes"));
  app.use("/api/activity-logs", require("../routes/activity_log_routes"));
  app.use("/api/currencies", require("../routes/currency_routes"));
  app.use("/api/hrms/hrms-branches", require("../hrms/routes/hrms_branch_route"));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, port: PORT }));
  // App-shell calls (sidebar, notifications…) are not part of this stack.
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Vendors test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));
  return app;
}

async function boot({ port = PORT } = {}) {
  const { mongod, uri } = await connectMemoryDb();
  console.log(`[GUARD CHECK 1 PASSED] in-memory Mongo ${uri}`);
  const world = await seed();
  const app = buildApp();
  const server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
  const actualPort = server.address().port;
  if (port !== 0 && [5001, 5183].includes(actualPort)) throw new Error("GUARD FAILURE: live port");
  console.log(`[GUARD CHECK 2] Vendors test backend http://127.0.0.1:${actualPort} (never :5001/:5183)`);
  const stop = async () => {
    await new Promise((r) => server.close(r));
    await mongoose.disconnect();
    await mongod.stop();
  };
  return { ...world, mongod, server, uri, baseUrl: `http://127.0.0.1:${actualPort}`, stop };
}

if (require.main === module) {
  boot().then((w) => {
    console.log(`[LOGIN] password ${PASSWORD}: admin@alpha.test, full.alpha@crm-test.local, viewglobal.alpha@crm-test.local, viewown.alpha@crm-test.local, noaccess.alpha@crm-test.local, roleadmin.alpha@crm-test.local, admin@beta.test, info@trinetratechnoworld.com, admin@nosales.test`);
    console.log("VENDORS STACK READY");
    const shutdown = () => w.stop().finally(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((err) => { console.error("Failed to start Vendors full test stack:", err); process.exit(1); });
}

module.exports = { boot, seed, buildApp, connectMemoryDb, tokenFor, PASSWORD };
