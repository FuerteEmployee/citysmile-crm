// Test harness for main-CRM API tests (Customers, Vendors, Items, Setup > Staff …).
// Runs on a throwaway in-memory MongoDB only: MONGO_URI is overwritten before any
// app module loads, and start() refuses to continue unless connected to 127.0.0.1.
// Same idea as src/hrms/testUtils/hrmsTestApp.js, for the main /api routes.
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");

let mongod;
let server;
let baseUrl;

/**
 * @param {Array<[string, string]>} routes  [mountPath, modulePath relative to src/], e.g.
 *   [["/api/clients", "routes/client_routes"]]
 */
async function start(routes) {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-test-secret";
  delete process.env.JOB_SECRET;

  await mongoose.connect(uri);
  const { host } = mongoose.connection;
  if (!["127.0.0.1", "localhost"].includes(host) || !uri.startsWith("mongodb://127.0.0.1")) {
    throw new Error(`Refusing to run CRM tests against non-memory DB: ${host}`);
  }

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  for (const [mount, mod] of routes) app.use(mount, require(`../${mod}`));
  // Unhandled errors become a 500 with the message, so tests can see crashes.
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { uri, baseUrl };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW_ONLY = { "View(Global)": true };

/**
 * One company with three logins: admin, a view-only staff member and a full-access
 * staff member (View+Create+Edit+Delete) for each module name in `modules`
 * (FEATURES_CONFIG names, e.g. "Customers", "Vendors", "Items", "Staff").
 */
async function seedCompany(label, modules = []) {
  const db = mongoose.connection.db;
  const tenantId = new mongoose.Types.ObjectId();
  await db.collection("tenants").insertOne({ _id: tenantId, company_name: `Company ${label}`, status: "active" });

  const perms = (caps) => Object.fromEntries(modules.map((m) => [m, caps]));
  const mk = async (kind, extra) => {
    const _id = new mongoose.Types.ObjectId();
    await db.collection("staffs").insertOne({
      _id, firstname: kind, lastname: label, email: `${kind}.${label.toLowerCase()}@crm-test.local`,
      password: "x", active: true, tenant_id: tenantId, admin: false, ...extra,
    });
    return { id: _id, token: jwt.sign({ id: String(_id), role: "staff" }, process.env.JWT_SECRET) };
  };
  return {
    tenantId,
    admin: await mk("admin", { admin: true }),
    viewOnly: await mk("viewer", { permissions: perms(VIEW_ONLY) }),
    full: await mk("editor", { permissions: perms(FULL) }),
    noAccess: await mk("nobody", { permissions: {} }),
  };
}

// Minimal HTTP client: { status, body }, never throws on 4xx/5xx.
function client(token) {
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    del: (p, b) => call("DELETE", p, b),
  };
}

module.exports = { start, stop, seedCompany, client };
