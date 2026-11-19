// Invoices Module Test Stack
// In-memory MongoDB -> Backend on 127.0.0.1:5102 (frontend: vite.config.test.invoices.ts on :5174)
// NEVER touches the live database, NEVER touches :5001 or :5183.
// Seeds the six test companies from invoiceSeed.js.
//
// Run: node src/testUtils/startInvoicesTestStack.js
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const PORT = 5102;
let mongod;
let server;

// Every route the Invoices pages and the dashboard shell call. A route that fails
// to load is logged and skipped (it then shows up as a 404 in the UI test).
const ROUTES = [
  ["/api/auth", "../routes/auth_routes"],
  ["/api/staff", "../routes/staff_routes"],
  ["/api/clients", "../routes/client_routes"],
  ["/api/notes", "../routes/note_routes"],
  ["/api/projects", "../routes/project_routes"],
  ["/api/tasks", "../routes/task_routes"],
  ["/api/roles", "../routes/role_routes"],
  ["/api/custom-fields", "../routes/custom_field_routes"],
  ["/api/client-groups", "../routes/client_group_routes"],
  ["/api/invoices", "../routes/invoice_routes"],
  ["/api/payments", "../routes/payment_routes"],
  ["/api/estimates", "../routes/estimate_routes"],
  ["/api/proposals", "../routes/proposal_routes"],
  ["/api/items", "../routes/item_routes"],
  ["/api/taxes", "../routes/tax_routes"],
  ["/api/settings", "../routes/setting_routes"],
  ["/api/mainsidebar", "../routes/mainsidebar_routes"],
  ["/api/credit-notes", "../routes/credit_note_routes"],
  ["/api/currencies", "../routes/currency_routes"],
  ["/api/payment-modes", "../routes/payment_mode_routes"],
  ["/api/bank-details", "../routes/bank_detail_routes"],
  ["/api/modules", "../routes/module_routes"],
  ["/api/reminders", "../routes/reminder_routes"],
  ["/api/quotation-types", "../routes/quotation_type_routes"],
  ["/api/activity-logs", "../routes/activity_log_routes"],
  ["/api/todos", "../routes/todo_routes"],
  ["/api/chat", "../routes/chat_routes"],
  ["/api/meetings", "../routes/meeting_routes"],
  ["/api/assistant", "../routes/assistant_routes"],
  ["/api/hrms", "../hrms/routes/index"],
];

async function boot() {
  console.log("==================================================================");
  console.log(`STARTING INVOICES TEST STACK (In-memory DB + Backend :${PORT})`);
  console.log("==================================================================");

  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-invoices-test-secret";
  process.env.PORT = String(PORT);
  delete process.env.JOB_SECRET;

  console.log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  console.log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${mongoose.connection.host}`);

  const { seedAll } = require("./invoiceSeed");
  const seed = await seedAll();
  console.log(`[SEED COMPLETE] ${seed.list.map((t) => `${t.label} <${t.admin.email}>`).join(", ")}`);

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  // Guard proof: every request's Host header is logged.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) console.log(`[REQ] ${req.method} host=${req.headers.host} ${req.originalUrl}`);
    next();
  });
  app.use("/api", require("../middleware/planModules").planModuleGate);

  const Staff = require("../models/Staff");
  // Test-only login: issues a token for a seeded email (no password check).
  app.post("/api/test-login", async (req, res) => {
    const staff = await Staff.findOne({ email: String(req.body?.email || "").trim().toLowerCase() }).lean();
    if (!staff) return res.status(401).json({ message: "Unknown test user" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET);
    res.json({ token, user: { ...staff, password: undefined } });
  });
  // Test-only: set a tenant Setting row (e.g. invPdfFormat) without the Settings UI.
  app.post("/api/test-setting", async (req, res) => {
    const Setting = require("../models/Setting");
    const staff = await Staff.findOne({ email: String(req.body?.email || "").toLowerCase() }).lean();
    if (!staff) return res.status(404).json({ message: "Unknown test user" });
    await Setting.findOneAndUpdate({ name: req.body.name, tenant_id: staff.tenant_id }, { value: String(req.body.value) }, { upsert: true });
    res.json({ ok: true });
  });
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri, port: PORT }));

  for (const [mount, mod] of ROUTES) {
    try {
      app.use(mount, require(mod));
    } catch (err) {
      console.log(`[ROUTE SKIPPED] ${mount}: ${err.message}`);
    }
  }
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));

  await new Promise((resolve) => { server = app.listen(PORT, "127.0.0.1", resolve); });
  console.log(`[GUARD CHECK 2] Test backend at http://127.0.0.1:${PORT}`);
  console.log("[GUARD CHECK 3] Live ports :5001 and :5183 are NOT used.");
  console.log("==================================================================");
  return { mongod, server, seed };
}

if (require.main === module) {
  boot().catch((err) => {
    console.error("Failed to start Invoices Test Stack:", err);
    process.exit(1);
  });
}

module.exports = { boot };
