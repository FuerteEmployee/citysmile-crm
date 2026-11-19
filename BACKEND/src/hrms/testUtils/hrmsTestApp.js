// Test harness for HRMS integration tests.
// Everything runs against a throwaway in-memory MongoDB (mongodb-memory-server),
// never the real database: MONGO_URI is overwritten before any app module loads,
// and connect() refuses to continue unless the connection is the in-memory one.
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");

let mongod;
let server;
let baseUrl;

async function start() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "hrms-test-secret";
  delete process.env.JOB_SECRET;

  await mongoose.connect(uri);
  const { host } = mongoose.connection;
  if (!["127.0.0.1", "localhost"].includes(host) || !uri.startsWith("mongodb://127.0.0.1")) {
    throw new Error(`Refusing to run HRMS tests against non-memory DB: ${host}`);
  }

  // Main-CRM models HRMS populates (registered by index.js in the real server).
  require("../../models/QuotationType");

  const app = express();
  app.use(express.json());
  app.use("/api/hrms", require("../routes/index"));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/hrms`;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

// Seeds one company with an admin who is both a CRM Staff login and an HRMS User,
// the same shape a real tenant admin has. Returns ids plus a bearer token.
async function seedCompany(label, { salaryAmount = 30000 } = {}) {
  const db = mongoose.connection.db;
  const tenantId = new mongoose.Types.ObjectId();
  const roleId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const email = `admin.${label.toLowerCase()}@hrms-test.local`;

  await db.collection("tenants").insertOne({ _id: tenantId, name: `Company ${label}`, status: "active" });
  await db.collection("hrmsroles").insertOne({ _id: roleId, role: "admin", label: "Admin", permissions: ["*"], tenant_id: tenantId });
  await db.collection("users").insertOne({
    _id: userId, name: `Admin ${label}`, email, password: "x", role: roleId,
    isActive: true, salaryAmount, tenant_id: tenantId, mobile: "9000000000",
  });
  await db.collection("staffs").insertOne({
    _id: staffId, firstname: "Admin", lastname: label, email, password: "x",
    admin: true, active: true, tenant_id: tenantId, hrms_user_id: userId,
  });

  const token = jwt.sign({ id: String(staffId), role: "admin" }, process.env.JWT_SECRET);
  return { tenantId, roleId, userId, staffId, token };
}

// Minimal HTTP client: returns { status, body } and never throws on 4xx/5xx.
function client(token) {
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
    del: (p) => call("DELETE", p),
  };
}

module.exports = { start, stop, seedCompany, client };
