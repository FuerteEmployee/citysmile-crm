// /api/control: Super Admin panel -> CRM server, signed with CONTROL_SECRET.
// Runs on an in-memory MongoDB only.
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const { signedHeaders } = require("../../utils/controlSignature");

const SECRET = "x".repeat(40);
let mongod, server, baseUrl, tenantA, tenantB, Tenant, SaasPlan;

const call = async (method, path, bodyObj, { secret = SECRET, headers = {} } = {}) => {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const res = await fetch(baseUrl + path, {
    method,
    headers: { "Content-Type": "application/json", ...signedHeaders(secret, { method, path, body }), ...headers },
    body: body || undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error("Refusing to run against a non-memory DB");
  process.env.MONGO_URI = uri;
  process.env.CONTROL_SECRET = SECRET;
  delete process.env.TENANT_ID;
  await mongoose.connect(uri);

  Tenant = require("../../models/Tenant");
  SaasPlan = require("../../models/SaasPlan");
  tenantA = await Tenant.create({ company_name: "Company A", status: "active" });
  tenantB = await Tenant.create({ company_name: "Company B", status: "active" });

  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use("/api/control", require("../../routes/control_routes"));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 60000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  process.env.CONTROL_SECRET = SECRET;
  delete process.env.TENANT_ID;
});

describe("control auth", () => {
  test("valid signature -> status ok", async () => {
    const r = await call("GET", "/api/control/status");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.tenant_count).toBe(2);
  });

  test("wrong secret -> 401", async () => {
    const r = await call("GET", "/api/control/status", undefined, { secret: "y".repeat(40) });
    expect(r.status).toBe(401);
  });

  test("no signature headers -> 401", async () => {
    const res = await fetch(baseUrl + "/api/control/status");
    expect(res.status).toBe(401);
  });

  test("tampered body -> 401", async () => {
    const path = `/api/control/tenants/${tenantA._id}`;
    const headers = signedHeaders(SECRET, { method: "PUT", path, body: JSON.stringify({ status: "active" }) });
    const res = await fetch(baseUrl + path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ status: "inactive" }),
    });
    expect(res.status).toBe(401);
  });

  test("replayed request -> 401", async () => {
    const path = "/api/control/status";
    const headers = signedHeaders(SECRET, { method: "GET", path, body: "" });
    const first = await fetch(baseUrl + path, { headers });
    const second = await fetch(baseUrl + path, { headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  test("expired timestamp -> 401", async () => {
    const r = await call("GET", "/api/control/status", undefined, { headers: { "X-Control-Timestamp": String(Date.now() - 10 * 60 * 1000) } });
    expect(r.status).toBe(401);
  });

  test("CONTROL_SECRET not set -> 404 (API off)", async () => {
    delete process.env.CONTROL_SECRET;
    const r = await call("GET", "/api/control/status");
    expect(r.status).toBe(404);
  });
});

describe("control tenant updates", () => {
  test("suspend, features and plan apply to the company", async () => {
    const r = await call("PUT", `/api/control/tenants/${tenantA._id}`, {
      status: "inactive",
      enabled_features: ["lead_followups"],
      plan: { name: "Gold", module_access: { leads: false } },
    });
    expect(r.status).toBe(200);
    const t = await Tenant.findById(tenantA._id).populate("plan_id").lean();
    expect(t.status).toBe("inactive");
    expect(t.enabled_features).toEqual(["lead_followups"]);
    expect(t.plan_id.name).toBe("Gold");
    expect(t.plan_id.module_access.leads).toBe(false);
    expect(t.plan_id.module_access.finance).toBe(true);
  });

  test("plan is reused by name, not duplicated", async () => {
    await call("PUT", `/api/control/tenants/${tenantB._id}`, { plan: { name: "Gold", module_access: { leads: true } } });
    expect(await SaasPlan.countDocuments({ name: "Gold" })).toBe(1);
  });

  test("bad status / unknown add-on -> 400", async () => {
    expect((await call("PUT", `/api/control/tenants/${tenantA._id}`, { status: "deleted" })).status).toBe(400);
    expect((await call("PUT", `/api/control/tenants/${tenantA._id}`, { enabled_features: ["nope"] })).status).toBe(400);
  });

  test("fields outside the allow-list are ignored", async () => {
    await call("PUT", `/api/control/tenants/${tenantB._id}`, { owner_id: new mongoose.Types.ObjectId(), login_code: "hack" });
    const t = await Tenant.findById(tenantB._id).lean();
    expect(t.owner_id).toBeUndefined();
    expect(t.login_code).toBeUndefined();
  });

  test("TENANT_ID lock: other company is hidden (404) and status lists only own", async () => {
    process.env.TENANT_ID = String(tenantA._id);
    expect((await call("GET", `/api/control/tenants/${tenantB._id}`)).status).toBe(404);
    expect((await call("PUT", `/api/control/tenants/${tenantB._id}`, { status: "inactive" })).status).toBe(404);
    expect((await call("GET", `/api/control/tenants/${tenantA._id}`)).status).toBe(200);
    const s = await call("GET", "/api/control/status");
    expect(s.json.tenant_count).toBe(1);
    expect(String(s.json.tenants[0]._id)).toBe(String(tenantA._id));
  });
});
