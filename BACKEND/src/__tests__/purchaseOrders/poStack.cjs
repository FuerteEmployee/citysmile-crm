// Shared test stack for the Purchase Orders API tests (part1..part7).
// Named .cjs on purpose so jest does not pick it up as a test file.
//
// SAFETY
//  - In-memory MongoDB only (via testUtils/crmTestApp.start, which refuses a
//    non-127.0.0.1 DB). CRM-BACKEND/.env is never loaded.
//  - Network guard: global fetch and http(s).request throw for any host other
//    than 127.0.0.1 / localhost and record the attempt (must stay empty).
//  - WhatsApp service + Cloudinary upload are jest.mock'ed in each test file
//    with the recorders exported here.
//  - A fake socket.io records every emit (app.set("io", fakeIo)).
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");
const http = require("http");
const https = require("https");
const crmTestApp = require("../../testUtils/crmTestApp");

// ─── Recorders ──────────────────────────────────────────────────────────────
const rec = {
  blockedNetwork: [], // non-local network attempts (must stay empty)
  whatsapp: [], // calls to the mocked whatsapp_service
  cloudinary: [], // calls to the mocked uploadToCloudinary
  io: [], // socket emits { room, event, payload }
};

// Values the mocked WhatsApp service returns; tests change them.
const waState = {
  integration: { _id: "int1", display_phone_number: "919000000000", is_live: true },
  documentResult: { success: true, messageId: "wamid.DOC" },
  templateResult: { success: true, messageId: "wamid.TPL" },
};
const cloudState = { url: "https://files.test.invalid/po.pdf" };

const waMock = {
  getActiveIntegration: async (tenantId) => {
    rec.whatsapp.push({ fn: "getActiveIntegration", tenantId: String(tenantId) });
    return waState.integration;
  },
  sendDocumentMessage: async (integration, mobile, url, filename, caption) => {
    rec.whatsapp.push({ fn: "sendDocumentMessage", mobile, url, filename, caption });
    return waState.documentResult;
  },
  sendDocumentTemplate: async (integration, mobile, template, lang, url, filename, params) => {
    rec.whatsapp.push({ fn: "sendDocumentTemplate", mobile, template, lang, url, filename, params });
    return waState.templateResult;
  },
};

const cloudinaryMockFactory = () => {
  ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_URL"].forEach((k) => delete process.env[k]);
  // Real module (uploadMemory = multer memoryStorage), only the upload is faked.
  const actual = jest.requireActual("../../hrms/utils/cloudinary_config");
  return {
    uploadMemory: actual.uploadMemory,
    uploadToCloudinary: async (file, folder) => {
      rec.cloudinary.push({ folder, originalname: file.originalname, size: file.buffer ? file.buffer.length : 0, head: file.buffer ? file.buffer.slice(0, 8).toString("latin1") : "" });
      return cloudState.url;
    },
  };
};

// ─── Network guard ──────────────────────────────────────────────────────────
const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]"];
let guarded = false;
const installNetworkGuard = () => {
  if (guarded) return;
  guarded = true;
  const realFetch = global.fetch;
  global.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input));
    if (!LOCAL.includes(url.hostname)) {
      rec.blockedNetwork.push({ via: "fetch", url: String(url) });
      return Promise.reject(new Error(`Network guard: blocked ${url.hostname}`));
    }
    return realFetch(input, init);
  };
  const wrap = (mod, name) => {
    for (const fn of ["request", "get"]) {
      const real = mod[fn];
      mod[fn] = function guardedRequest(...args) {
        const a = args[0];
        const host = typeof a === "string" || a instanceof URL ? new URL(String(a)).hostname : a && (a.hostname || a.host);
        if (host && !LOCAL.includes(String(host).split(":")[0])) {
          rec.blockedNetwork.push({ via: `${name}.${fn}`, host });
          throw new Error(`Network guard: blocked ${host}`);
        }
        return real.apply(this, args);
      };
    }
  };
  wrap(http, "http");
  wrap(https, "https");
};

// Keys that exist only in CRM-BACKEND/.env — if any is set, .env was loaded.
const ENV_ONLY_KEYS = ["GEMINI_API_KEY", "META_WEBHOOK_VERIFY_TOKEN", "WA_WEBHOOK_VERIFY_TOKEN", "COOKIE_ENCRYPTION_KEY", "INTEGRATION_ENCRYPTION_KEY", "MEETING_RECORDINGS_S3_BUCKET", "META_LEAD_DEFAULT_TENANT_ID"];

// ─── App ────────────────────────────────────────────────────────────────────
let server;
let baseUrl;
let memUri;
const fakeIo = { to: (room) => ({ emit: (event, payload) => rec.io.push({ room: String(room), event, payload }) }) };

const DEFAULT_ROUTES = [
  ["/api/purchase-orders", "routes/purchase_order_routes"],
  ["/api/items", "routes/item_routes"],
];

async function startStack(routes = DEFAULT_ROUTES) {
  const leaked = ENV_ONLY_KEYS.filter((k) => process.env[k] !== undefined);
  if (leaked.length) throw new Error(`STOP: .env looks loaded (${leaked.join(",")})`);
  if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith("mongodb://127.0.0.1")) {
    throw new Error("STOP: MONGO_URI points at a non-memory DB before start");
  }
  installNetworkGuard();
  // crmTestApp: in-memory DB + refuses anything not on 127.0.0.1.
  const { uri } = await crmTestApp.start([]);
  memUri = uri;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error("STOP: not an in-memory DB");
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("STOP: mongoose host not local");
  // eslint-disable-next-line no-console
  console.log(`[guard] in-memory MongoDB: ${uri} (mongoose host ${mongoose.connection.host})`);

  // Models index.js registers at boot (populate("role"), populate("tax")).
  ["Role", "Tax", "Staff", "Client", "Item", "PoItem", "Tenant", "Contact"].forEach((m) => require(`../../models/${m}`));

  // Own small app (same pattern as crmTestApp) so a fake io can be set.
  const app = express();
  app.use(express.json({ limit: "10mb" })); // same body limit as index.js
  app.set("io", fakeIo);
  for (const [mount, mod] of routes) app.use(mount, require(`../../${mod}`));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message, code: err.code }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { uri, baseUrl };
}

async function stopStack() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await crmTestApp.stop();
}

function guardReport() {
  return {
    memUri,
    envOnlyKeysSet: ENV_ONLY_KEYS.filter((k) => process.env[k] !== undefined),
    cloudinaryEnv: Object.keys(process.env).filter((k) => k.startsWith("CLOUDINARY")),
    blockedNetwork: rec.blockedNetwork.length,
  };
}

// ─── HTTP client ────────────────────────────────────────────────────────────
// Round 29 (S4): a PO needs a customer now. PO create (POST /api/purchase-orders)
// and edit (PUT /api/purchase-orders/<id>) bodies that don't name one get the
// company's "Walk-in <label>" test customer (customers.walkin), so the other
// customers (c1 Acme, c2 Beta) stay exactly as the tests used them. A test that checks the rule itself
// sends customer: null / "" explicitly (nothing is added then).
const defaultCustomerCache = new Map();
async function defaultCustomerFor(token) {
  const id = token && jwt.decode(token)?.id;
  if (!id) return null;
  if (defaultCustomerCache.has(id)) return defaultCustomerCache.get(id);
  const db = mongoose.connection.db;
  const staff = await db.collection("staffs").findOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { projection: { tenant_id: 1 } });
  const c = staff?.tenant_id ? await db.collection("clients").findOne({ tenant_id: staff.tenant_id, company: /^Walk-in / }, { projection: { _id: 1 } }) : null;
  const value = c ? String(c._id) : null;
  defaultCustomerCache.set(id, value);
  return value;
}
const PO_WRITE_PATH = /^\/api\/purchase-orders(\/[0-9a-f]{24})?$/i;

function api(token) {
  const call = async (method, path, body) => {
    if ((method === "POST" || method === "PUT") && PO_WRITE_PATH.test(path) && (method === "POST") === !/[0-9a-f]{24}$/i.test(path)
      && body && typeof body === "object" && !Array.isArray(body) && !("customer" in body)) {
      const c = await defaultCustomerFor(token);
      if (c) body = { ...body, customer: c };
    }
    const res = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    del: (p, b) => call("DELETE", p, b),
    // multipart upload for /:id/whatsapp
    upload: async (path, { file, filename = "po.pdf", type = "application/pdf", fields = {} } = {}) => {
      const form = new FormData();
      Object.entries(fields).forEach(([k, v]) => form.append(k, v));
      if (file) form.append("file", new Blob([file], { type }), filename);
      const res = await fetch(baseUrl + path, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json };
    },
  };
}

// ─── Seed ───────────────────────────────────────────────────────────────────
const sign = (id, role = "staff") => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET);
const PO = "Purchase Orders";

/**
 * One company with the full role set from the test plan.
 * features: Tenant.enabled_features. Returns ids, tokens, api clients, items, customers.
 * settings: by default the company gets a PoSettings document with TWO divisions
 *   (the app default is Brady only; many tests need a second number series —
 *   SPARKLING_DIVISION). Pass settings: false for a company whose settings must
 *   be created by the app on first read (tests of the defaults / the gate).
 */
const SPARKLING_DIVISION = { key: "sparkling", name: "Sparkling", purchase_prefix: "SPK-PPO", sales_prefix: "SPK-SPO", active: true };
async function seedTenant(label, { features = ["purchase_orders"], settings = true } = {}) {
  const db = mongoose.connection.db;
  const tenantId = new mongoose.Types.ObjectId();
  await db.collection("tenants").insertOne({ _id: tenantId, company_name: `Company ${label}`, status: "active", enabled_features: features });

  const users = {};
  const mk = async (key, extra) => {
    const _id = new mongoose.Types.ObjectId();
    await db.collection("staffs").insertOne({
      _id, firstname: key, lastname: label, email: `${key}.${label.toLowerCase()}@crm-test.local`,
      password: "x", active: true, tenant_id: tenantId, admin: false, ...extra,
    });
    users[key] = { id: _id, token: sign(_id), api: api(sign(_id)) };
    return users[key];
  };
  const perm = (caps) => ({ [PO]: caps });
  await mk("admin", { admin: true });
  await mk("maker", { permissions: perm({ "View(Global)": true, Create: true, Edit: true }) });
  await mk("maker2", { permissions: perm({ "View(Global)": true, Create: true, Edit: true }) });
  await mk("full", { permissions: perm({ "View(Global)": true, Create: true, Edit: true, Delete: true }) });
  await mk("approver", { permissions: perm({ "View(Global)": true, Approve: true }) });
  await mk("pricer", { permissions: perm({ "View(Global)": true, "Manage Prices": true }) });
  await mk("own", { permissions: perm({ "View (Own)": true, Create: true }) });
  await mk("ownApprover", { permissions: perm({ "View (Own)": true, Create: true, Approve: true }) });
  await mk("viewer", { permissions: perm({ "View(Global)": true }) });
  await mk("noAccess", { permissions: {} });
  await mk("inactiveApprover", { active: false, permissions: perm({ "View(Global)": true, Approve: true }) });
  // Role-based approver (no staff-level PO perms) — tests role fallback.
  const roleId = new mongoose.Types.ObjectId();
  await db.collection("roles").insertOne({ _id: roleId, name: `PO Approver ${label}`, tenant_id: tenantId, permissions: perm({ "View(Global)": true, Approve: true }) });
  await mk("roleApprover", { role: roleId });
  // Staff whose own permission switches Approve OFF although the role has it.
  await mk("roleApproverDenied", { role: roleId, permissions: perm({ "View(Global)": true, Approve: false }) });

  // Taxes
  const tax18 = new mongoose.Types.ObjectId();
  const tax5 = new mongoose.Types.ObjectId();
  await db.collection("taxes").insertMany([
    { _id: tax18, name: "GST18", taxrate: 18, tenant_id: tenantId },
    { _id: tax5, name: "GST5", taxrate: 5, tenant_id: tenantId },
  ]);

  // Customers (one without phone)
  const Client = require("../../models/Client");
  const customers = {
    c1: await Client.create({ company: `Acme ${label}`, tenant_id: tenantId, phonenumber: "9876543210", address: "1 Road", city: "Surat", state: "Gujarat", zip: "395001", gst_number: "24ABCDE1234F1Z5", email: "acme@x.test" }),
    c2: await Client.create({ company: `Beta ${label}`, tenant_id: tenantId, phonenumber: "+91 98765 43211" }),
    noPhone: await Client.create({ company: `NoPhone ${label}`, tenant_id: tenantId }),
    // Round 29: the default customer of PO bodies that name none (see api()).
    walkin: await Client.create({ company: `Walk-in ${label}`, tenant_id: tenantId, phonenumber: "9812345670" }),
  };

  // PO items (PoItem — the PO module's own list) with price master values
  // (plan section 0). I6 carries 23 % GST (was tax 18 % + tax2 5 % on the old
  // CRM-Item based price list).
  const PoItem = require("../../models/PoItem");
  const items = {
    I1: await PoItem.create({ name: `I1 Label ${label}`, item_code: `I1-${label}`, tenant_id: tenantId, cost_price: 100, master_price: 150, distributor_price: 140, end_customer_price: 160, hsn: "4821", unit: "Nos", tax_rate: 18 }),
    I2: await PoItem.create({ name: `I2 NoCost ${label}`, item_code: `I2-${label}`, tenant_id: tenantId, cost_price: 0, end_customer_price: 200 }),
    I3: await PoItem.create({ name: `I3 NoList ${label}`, item_code: `I3-${label}`, tenant_id: tenantId, cost_price: 80, end_customer_price: 0 }),
    I4: await PoItem.create({ name: `I4 Big ${label}`, item_code: `I4-${label}`, tenant_id: tenantId, cost_price: 99999.99, end_customer_price: 120000 }),
    I5: await PoItem.create({ name: `I5 Brady ${label}`, item_code: label === "A" ? "BR-001" : `BR-001-${label}`, tenant_id: tenantId, cost_price: 50, end_customer_price: 70 }),
    I6: await PoItem.create({ name: `I6 TwoTax ${label}`, item_code: `I6-${label}`, tenant_id: tenantId, cost_price: 10, end_customer_price: 20, tax_rate: 23 }),
  };
  // CRM Items (Items module) — these must NEVER show up in the PO module.
  const Item = require("../../models/Item");
  const crmItems = {
    widget: await Item.create({ name: "CRM Only Widget", tenant_id: tenantId, item_code: `CRM-W-${label}`, cost_price: 5, end_customer_price: 9, tax: tax18 }),
    i1: await Item.create({ name: "I1", tenant_id: tenantId, cost_price: 1, end_customer_price: 2 }),
  };
  if (settings) {
    // Same shape the controller's getSettingsDoc creates, plus Sparkling.
    const PoSettings = require("../../models/PoSettings");
    const { DEFAULT_PO_SETTINGS, DEFAULT_FORMAT } = PoSettings;
    await PoSettings.create({
      tenant_id: tenantId,
      ...DEFAULT_PO_SETTINGS,
      divisions: [...DEFAULT_PO_SETTINGS.divisions, SPARKLING_DIVISION],
      format_history: [{ version: 1, format: DEFAULT_FORMAT, saved_at: new Date() }],
    });
  }

  return { label, tenantId, users, items, crmItems, customers, taxes: { tax18, tax5 }, roleId };
}

// A staff without a company, a contact token, a super admin.
async function seedOddUsers() {
  const db = mongoose.connection.db;
  const noTenantId = new mongoose.Types.ObjectId();
  await db.collection("staffs").insertOne({ _id: noTenantId, firstname: "NoTenant", lastname: "X", email: "notenant@crm-test.local", password: "x", active: true, admin: false, permissions: { [PO]: { "View(Global)": true, Create: true } } });
  const contactId = new mongoose.Types.ObjectId();
  await db.collection("contacts").insertOne({ _id: contactId, firstname: "Con", lastname: "Tact", email: "contact@crm-test.local", password: "x", active: true });
  const saId = new mongoose.Types.ObjectId();
  await db.collection("staffs").insertOne({ _id: saId, firstname: "Super", lastname: "Admin", email: "sa@crm-test.local", password: "x", active: true, is_superadmin: true, admin: true });
  return {
    noTenant: { id: noTenantId, api: api(sign(noTenantId)) },
    contact: { id: contactId, api: api(sign(contactId, "contact")) },
    superAdmin: { id: saId, api: api(sign(saId)) },
    anon: { api: api(null) },
    badToken: { api: api("not.a.jwt") },
  };
}

const PO_PATH = "/api/purchase-orders";
const line = (item, qty = 1, extra = {}) => ({ item_id: String(item._id), qty, ...extra });

// ─── Brady flow helpers (round 28) ─────────────────────────────────────────
// The financial year of the PO numbers made today ("26-27").
const fyNow = () => require("../../services/purchaseOrderRules").fyOf(new Date());

// R1 removed Sales PO: the API can't make one any more, so tests that need an
// OLD sales record (read-only, list filters, …) put one straight into the
// in-memory DB, the way it was stored before.
async function insertSalesPo(T, { status = "draft", number, items, customer = T.customers.c1, extra = {} } = {}) {
  const PurchaseOrder = require("../../models/PurchaseOrder");
  const lines = items || [{ item_id: T.items.I1._id, item_code: T.items.I1.item_code, name: T.items.I1.name, qty: 2, cost_price: 100, list_price: 160, selling_price: 160, rate: 160, tax_rate: 18, amount: 320, tax_amount: 57.6, margin_pct: 37.5 }];
  const subtotal = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const tax = lines.reduce((s, l) => s + (l.tax_amount || 0), 0);
  return PurchaseOrder.create({
    tenant_id: T.tenantId,
    type: "sales",
    division: "brady",
    po_number: number || `SPO-2025-${String(Math.floor(Math.random() * 9000) + 1000)}`,
    customer: customer._id,
    customer_snapshot: { name: customer.company, phone: customer.phonenumber || "", whatsapp: customer.phonenumber || "" },
    tax_mode: "intra",
    items: lines,
    totals: { subtotal, cgst: tax / 2, sgst: tax / 2, igst: 0, tax_total: tax, grand_total: subtotal + tax, sell_value: subtotal, cost_value: 200, margin_pct: 37.5 },
    status,
    created_by: T.users.maker.id,
    history: [{ action: "created", by: T.users.maker.id, at: new Date() }],
    ...extra,
  });
}

// A Purchase PO taken through the R4 flow: maker submits (always pending),
// approver says Yes. Returns the approved PO.
async function approvedPo(T, items, extra = {}, { maker = "maker", approver = "approver" } = {}) {
  const r = await T.users[maker].api.post(PO_PATH, { type: "purchase", division: "brady", items, submit: true, ...extra });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.status !== "pending_approval") throw new Error(`expected pending_approval, got ${r.body.status}`);
  const a = await T.users[approver].api.post(`${PO_PATH}/${r.body._id}/approve`, {});
  if (a.status !== 200) throw new Error(`approve failed ${a.status} ${JSON.stringify(a.body)}`);
  return a.body;
}

// Jest 30 also collects .cjs files under __tests__. When this helper is run as
// its own suite (require.main is this module) it only checks the guards.
const runAsSuite = (() => {
  try {
    const tp = typeof expect !== "undefined" && expect.getState().testPath;
    return !!tp && require("path").resolve(tp).toLowerCase() === __filename.toLowerCase();
  } catch {
    return false;
  }
})();
if (runAsSuite) {
  test("poStack guard: .env not loaded, no CLOUDINARY_* in env, memory binary configured", () => {
    expect(ENV_ONLY_KEYS.filter((k) => process.env[k] !== undefined)).toEqual([]);
    expect(String(process.env.MONGO_URI || "mongodb://127.0.0.1").startsWith("mongodb://127.0.0.1")).toBe(true);
    expect(String(process.env.MONGOMS_SYSTEM_BINARY || "")).toMatch(/mongod-x64-win32-8\.2\.6\.exe$/);
  });
}

module.exports = {
  rec, waState, cloudState, waMock, cloudinaryMockFactory,
  startStack, stopStack, guardReport, api, seedTenant, seedOddUsers, sign,
  PO_PATH, line, SPARKLING_DIVISION, fyNow, insertSalesPo, approvedPo,
  getBaseUrl: () => baseUrl,
};
