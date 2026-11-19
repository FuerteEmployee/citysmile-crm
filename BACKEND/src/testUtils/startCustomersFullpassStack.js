// Customers full test pass — in-memory backend on 127.0.0.1:5204.
// Frontend: CRM-FRONTEND-NEW/vite.config.test.customers.ts on 127.0.0.1:5304.
// NEVER touches the live database, NEVER uses :5001 / :5183 or another agent's ports.
// Outbound HTTP(S) is blocked and EmailService.sendMail is stubbed (no real mail / WhatsApp).
//
// Run: node src/testUtils/startCustomersFullpassStack.js
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const F = require("./customersFullpassFixtures");

const PORT = 5204;

// Every route the Customers pages and the dashboard shell call. A route that fails to
// load is logged and skipped (it then shows as a 404 in the UI test).
const ROUTES = [
  ["/api/auth", "../routes/auth_routes"],
  ["/api/staff", "../routes/staff_routes"],
  ["/api/clients", "../routes/client_routes"],
  ["/api/client-groups", "../routes/client_group_routes"],
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
  ["/api/credit-notes", "../routes/credit_note_routes"],
  ["/api/subscriptions", "../routes/subscription_routes"],
  ["/api/expenses", "../routes/expense_routes"],
  ["/api/expense-categories", "../routes/expense_category_routes"],
  ["/api/contracts", "../routes/contract_routes"],
  ["/api/contract-types", "../routes/contract_type_routes"],
  ["/api/tickets", "../routes/ticket_routes"],
  ["/api/ticket-statuses", "../routes/ticket_status_routes"],
  ["/api/departments", "../routes/department_routes"],
  ["/api/priorities", "../routes/priority_routes"],
  ["/api/services", "../routes/service_routes"],
  ["/api/items", "../routes/item_routes"],
  ["/api/taxes", "../routes/tax_routes"],
  ["/api/settings", "../routes/setting_routes"],
  ["/api/mainsidebar", "../routes/mainsidebar_routes"],
  ["/api/currencies", "../routes/currency_routes"],
  ["/api/payment-modes", "../routes/payment_mode_routes"],
  ["/api/modules", "../routes/module_routes"],
  ["/api/reminders", "../routes/reminder_routes"],
  ["/api/files", "../routes/file_routes"],
  ["/api/activity-logs", "../routes/activity_log_routes"],
  ["/api/todos", "../routes/todo_routes"],
  ["/api/goals", "../routes/goal_routes"],
  ["/api/hrms", "../hrms/routes/index"],
];

function buildApp({ log = false } = {}) {
  const app = express();
  // Only the :5304 test frontend (also reached as erp.othercompany.test:5304 for the Rudraverse host check).
  app.use(cors({ origin: (o, cb) => cb(null, !o || /^http:\/\/[a-z0-9.-]+:5304$/i.test(o)), credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  if (log) app.use((req, res, next) => { if (req.path.startsWith("/api/")) console.log(`[REQ] ${req.method} host=${req.headers.host} ${req.originalUrl}`); next(); });
  app.use("/api", require("../middleware/planModules").planModuleGate);

  const Staff = require("../models/Staff");
  // Test-only login: issues a token for a seeded email (no password check) so the UI test
  // can start a session per role without going through the login form.
  app.post("/api/test-login", async (req, res) => {
    const staff = await Staff.findOne({ email: String(req.body?.email || "").trim().toLowerCase() }).select("-password").lean();
    if (!staff) return res.status(401).json({ message: "Unknown test user" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET);
    res.json({ token, user: staff });
  });
  app.get("/api/test-outbox", (req, res) => res.json({ mails: F.sentMails.map((m) => ({ to: m.to, cc: m.cc, subject: m.subject, htmlLen: (m.html || "").length, attachments: (m.attachments || []).length })), outbound: F.outboundAttempts }));
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri: process.env.MONGO_URI, port: PORT }));

  for (const [mount, mod] of ROUTES) {
    try { app.use(mount, require(mod)); } catch (err) { console.log(`[ROUTE SKIPPED] ${mount}: ${err.message}`); }
  }
  app.use("/api", (req, res) => res.status(404).json({ message: "Not mounted in Customers test stack", path: req.originalUrl }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message || "Internal server error" }));
  return app;
}

async function boot({ port = PORT, seed = true, log = true, extraCustomers = 30 } = {}) {
  const { mongod, uri } = await F.connectMemoryDb();
  console.log(`[GUARD CHECK 1 PASSED] In-memory Mongo ${uri}`);
  F.blockOutbound();
  F.stubEmail();
  const world = seed ? await F.seedCustomersWorld({ extraCustomers }) : null;
  const app = buildApp({ log });
  const server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
  console.log(`[GUARD CHECK 2] Customers test backend at http://127.0.0.1:${port}`);
  console.log("[GUARD CHECK 3] Live ports :5001 / :5183 are NOT used.");
  if (world) for (const T of [world.A, world.B, world.R, world.P]) console.log(`[LOGIN] ${T.key}: ${Object.entries(T.users).map(([k, u]) => `${k}=${u.email}`).join(" ")}`);
  const stop = async () => {
    await new Promise((r) => server.close(r));
    await require("mongoose").disconnect();
    await mongod.stop();
  };
  return { mongod, server, world, stop, port };
}

if (require.main === module) {
  boot().then(({ stop }) => {
    const bye = async () => { await stop().catch(() => {}); process.exit(0); };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  }).catch((err) => { console.error("Failed to start Customers full-pass stack:", err); process.exit(1); });
}

module.exports = { boot, buildApp, PORT, ROUTES };
