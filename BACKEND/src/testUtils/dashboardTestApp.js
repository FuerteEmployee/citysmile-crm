// In-process harness for the DASHBOARD jest API tests (src/__tests__/dashboard/).
// Throwaway in-memory MongoDB only: MONGO_URI is overwritten before any app module loads and
// start() refuses to continue unless connected to 127.0.0.1. Listens on a random free port
// (never 5001/5183 or another agent's port).
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");

let mongod;
let server;
let baseUrl;

const ROUTES = [
  ["/api/invoices", "routes/invoice_routes"],
  ["/api/leads", "routes/lead_routes"],
  ["/api/projects", "routes/project_routes"],
  ["/api/tasks", "routes/task_routes"],
  ["/api/estimates", "routes/estimate_routes"],
  ["/api/proposals", "routes/proposal_routes"],
  ["/api/quotations", "routes/quotation_routes"],
  ["/api/tickets", "routes/ticket_routes"],
  ["/api/announcements", "routes/announcement_routes"],
  ["/api/todos", "routes/todo_routes"],
  ["/api/expenses", "routes/expense_routes"],
  ["/api/activity-logs", "routes/activity_log_routes"],
  ["/api/reminders", "routes/reminder_routes"],
];

async function start() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-dashboard-jest-secret";
  delete process.env.JOB_SECRET;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`Refusing non-memory DB: ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error(`Refusing non-local DB host ${mongoose.connection.host}`);

  require("../models/SaasPlan");
  require("../models/Role");
  const { seedAll } = require("./dashboardSeed");
  const seed = await seedAll();

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/api", require("../middleware/planModules").planModuleGate);
  for (const [mount, mod] of ROUTES) app.use(mount, require(`../${mod}`));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { uri, baseUrl, seed, ROUTES };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

function client(token, rawAuth) {
  const call = async (method, path, body) => {
    const headers = { "Content-Type": "application/json" };
    if (rawAuth !== undefined) headers.Authorization = rawAuth;
    else if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b), del: (p) => call("DELETE", p) };
}

module.exports = { start, stop, client, ROUTES };
