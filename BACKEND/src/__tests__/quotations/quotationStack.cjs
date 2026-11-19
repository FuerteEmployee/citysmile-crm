// Quotation Maker test stack (jest). Same safety pattern as ../leads/leadsStack.cjs:
// - In-memory MongoDB only: MONGO_URI is overwritten before any app module loads and
//   start() throws unless the connection is on 127.0.0.1.
// - Every real outbound network call (axios/http/https/fetch to a non-local host) is
//   blocked and recorded in guard.blockedExternal. nodemailer is faked (guard.emails).
// - Socket.io is faked: app.set("io", fakeIo); every emit is recorded in guard.socketEvents
//   as { room, event, payload }.
const http = require("http");
const https = require("https");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");

const guard = { blockedExternal: [], emails: [], socketEvents: [] };
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function installNetworkGuard() {
  if (installNetworkGuard.done) return;
  installNetworkGuard.done = true;
  const axios = require("axios");
  axios.defaults.adapter = async (config) => {
    const url = new URL(axios.getUri(config));
    guard.blockedExternal.push(url.toString());
    throw new Error(`[quotation test guard] blocked axios call to ${url.host}`);
  };
  const hostOf = (args) => {
    const a = args[0];
    if (typeof a === "string" || a instanceof URL) return new URL(a).hostname;
    return (a && (a.hostname || a.host)) || "localhost";
  };
  for (const mod of [http, https]) {
    for (const fn of ["request", "get"]) {
      const original = mod[fn];
      mod[fn] = function guarded(...args) {
        const host = String(hostOf(args)).replace(/:\d+$/, "");
        if (!LOCAL_HOSTS.has(host)) {
          guard.blockedExternal.push(`${fn} ${host}`);
          throw new Error(`[quotation test guard] blocked real network call to ${host}`);
        }
        return original.apply(this, args);
      };
    }
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      guard.blockedExternal.push(`fetch ${host}`);
      return Promise.reject(new Error(`[quotation test guard] blocked real network call to ${host}`));
    }
    return realFetch(input, init);
  };
  const nodemailer = require("nodemailer");
  nodemailer.createTransport = () => ({
    sendMail: async (msg) => { guard.emails.push(msg); return { messageId: `fake-${guard.emails.length}` }; },
    verify: async () => true,
    close: () => {},
  });
}

let mongod;
let server;
let baseUrl;

// Same mount paths as index.js.
const ROUTES = [
  ["/api/quotations", "routes/quotation_routes"],
  ["/api/quotation-types", "routes/quotation_type_routes"],
  ["/api/clients", "routes/client_routes"],
  ["/api/media", "routes/media_routes"],
  ["/api/bank-details", "routes/bank_detail_routes"],
  ["/api/settings", "routes/setting_routes"],
  ["/api/hrms/hrms-branches", "hrms/routes/hrms_branch_route"],
];

async function start({ port = 0 } = {}) {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`Refusing to run Quotation tests against non-memory DB: ${uri}`);
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-quotation-test-secret";
  delete process.env.JOB_SECRET;

  installNetworkGuard();

  await mongoose.connect(uri);
  if (!LOCAL_HOSTS.has(mongoose.connection.host)) throw new Error(`Refusing non-local DB host: ${mongoose.connection.host}`);

  const app = express();
  app.use(require("cors")({ origin: true, credentials: true }));
  app.use(express.json({ limit: "10mb" }));
  let room = null;
  const fakeIo = {
    to: (r) => { room = r; return fakeIo; },
    in: (r) => { room = r; return fakeIo; },
    emit: (event, payload) => { guard.socketEvents.push({ room, event, payload }); room = null; return true; },
  };
  app.set("io", fakeIo);
  for (const [mount, mod] of ROUTES) app.use(mount, require(`../../${mod}`));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }));

  // Make sure unique indexes exist before tests rely on them.
  await Promise.all(["Quotation", "QuotationType"].map((m) => require(`../../models/${m}`).init()));

  await new Promise((resolve) => { server = app.listen(port, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { uri, baseUrl, app };
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

const sign = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET);

/**
 * Users (A): admin, noPerm (no Quotations perm), settingsView (Settings View(Global) only),
 * approver (Quotations View(Global)+Approve), maker (Quotations View/Create/Edit/Delete, no Approve),
 * pilot (admin, Trinetra pilot e-mail). Users (B): admin, maker.
 */
async function seedCompany(label, { full = false } = {}) {
  const Tenant = require("../../models/Tenant");
  const Staff = require("../../models/Staff");
  const tenantId = new mongoose.Types.ObjectId();
  await Tenant.create({ _id: tenantId, company_name: `Quote Co ${label}`, status: "active", enabled_features: [] });

  const users = {};
  const mk = async (key, extra = {}) => {
    const _id = new mongoose.Types.ObjectId();
    const email = extra.email || `${key}.${label.toLowerCase()}@quote-test.local`;
    await Staff.create({
      _id, firstname: key, lastname: label, password: "password123", active: true,
      tenant_id: tenantId, admin: false, ...extra, email,
    });
    users[key] = { id: _id, token: sign(_id), email };
  };
  await mk("admin", { admin: true });
  await mk("maker", { permissions: { Quotations: { "View(Global)": true, Create: true, Edit: true, Delete: true } } });
  if (full) {
    await mk("noPerm", { permissions: {} });
    await mk("settingsView", { permissions: { Settings: { "View(Global)": true } } });
    await mk("approver", { permissions: { Quotations: { "View(Global)": true, Approve: true } } });
    await mk("pilot", { admin: true, email: "info@trinetratechnoworld.com" });
  }
  return { label, tenantId, users };
}

async function seedAll() {
  const HRMSBranch = require("../../hrms/models/hrms_branch_model");
  const Client = require("../../models/Client");
  const BankDetail = require("../../models/BankDetail");
  const QuotationType = require("../../models/QuotationType");
  const Quotation = require("../../models/Quotation");

  const A = await seedCompany("A", { full: true });
  const B = await seedCompany("B");

  A.branches = [
    await HRMSBranch.create({ name: "Branch A1", tenant_id: A.tenantId }),
    await HRMSBranch.create({ name: "Branch A2", tenant_id: A.tenantId }),
  ];
  A.customers = [
    await Client.create({ company: "Cust A1", tenant_id: A.tenantId, branch: A.branches[0]._id, phonenumber: "9800000001", address: "1 Road", city: "Surat" }),
    await Client.create({ company: "Cust A2", tenant_id: A.tenantId, branch: A.branches[0]._id }),
    await Client.create({ company: "Cust A3", tenant_id: A.tenantId, branch: A.branches[1]._id }),
  ];
  A.bank = await BankDetail.create({ bankName: "Test Bank", accountHolderName: "Quote Co A", accountNumber: "000111", ifscCode: "TEST0001", branch: A.branches[0]._id, tenant_id: A.tenantId });
  A.types = {
    trinetra: await QuotationType.create({ name: "Trinetra Technoworld Pvt Ltd", slug: "trinetra-technoworld-pvt-ltd", format: "both", order: 1, tenant_id: A.tenantId }),
    electrical: await QuotationType.create({ name: "Electrical", slug: "electrical", format: "simple", order: 2, tenant_id: A.tenantId }),
    interior: await QuotationType.create({ name: "Interior", slug: "interior", format: "pro", order: 3, active: false, tenant_id: A.tenantId }),
  };
  await HRMSBranch.updateOne({ _id: A.branches[0]._id }, { $set: { quotationTypes: [A.types.trinetra._id] } });

  B.customers = [await Client.create({ company: "Cust B1", tenant_id: B.tenantId })];
  B.types = { main: await QuotationType.create({ name: "Tenant B Type", slug: "tenant-b-type", format: "both", order: 1, tenant_id: B.tenantId }) };
  B.quotations = await Quotation.create([
    { number: "QUO-B00001", tenant_id: B.tenantId, client: B.customers[0]._id, quotation_type: B.types.main._id, total: 1000, created_by: B.users.admin.id },
    { number: "QUO-B00002", tenant_id: B.tenantId, client: B.customers[0]._id, quotation_type: B.types.main._id, total: 2000, created_by: B.users.admin.id },
  ]);
  return { A, B };
}

async function setFeatures(tenantId, keys) {
  const Tenant = require("../../models/Tenant");
  await Tenant.updateOne({ _id: tenantId }, { $set: { enabled_features: keys } });
}

function client(token) {
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    del: (p, b) => call("DELETE", p, b),
  };
}

module.exports = { start, stop, seedAll, setFeatures, client, sign, guard, getBaseUrl: () => baseUrl };

// Jest's default testMatch also picks up .cjs files under __tests__; when this helper is run
// as its own "suite" give it one trivial test instead of an "empty suite" failure.
const runAsSuite = () => {
  try {
    const p = typeof expect !== "undefined" && expect.getState().testPath;
    return !!p && require("path").resolve(p).toLowerCase() === __filename.toLowerCase();
  } catch { return false; }
};
if (typeof test === "function" && runAsSuite()) {
  test("quotationStack helper loads", () => expect(typeof start).toBe("function"));
}
