// Customers module — backend UNIT tests (model rules + controller logic called directly).
// In-memory MongoDB only (crmTestApp.start refuses anything but 127.0.0.1).
// A failing test = a bug: each assertion states the CORRECT expected behaviour.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedCompany } = require("../../testUtils/crmTestApp");

let Client, Contact, ClientGroup, HRMSBranch, Invoice, Payment, ctrl;
let A, B;

// Minimal Express-like req/res for calling controllers directly.
const mkRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const call = async (fn, { user, params = {}, query = {}, body = {}, permissionLevel = "global" }) => {
  const res = mkRes();
  await fn({ user, params, query, body, permissionLevel, headers: {}, ip: "127.0.0.1" }, res);
  return res;
};
let userA; // Staff document of tenant A admin (controllers read req.user._id / tenant_id)

beforeAll(async () => {
  await start([]);
  Client = require("../../models/Client");
  Contact = require("../../models/Contact");
  ClientGroup = require("../../models/ClientGroup");
  HRMSBranch = require("../../hrms/models/hrms_branch_model");
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
  require("../../models/Staff");
  ctrl = require("../../controllers/client_controller");
  await Promise.all([Client.init(), ClientGroup.init(), Invoice.init()]);
  A = await seedCompany("A", ["Customers"]);
  B = await seedCompany("B", ["Customers"]);
  userA = await mongoose.model("Staff").findById(A.admin.id);
});
afterAll(stop);

describe("Client model", () => {
  test("[unit] company is required", () => {
    const err = new Client({}).validateSync();
    expect(err.errors.company).toBeDefined();
  });
  test("[unit] active defaults to true", () => {
    expect(new Client({ company: "X" }).active).toBe(true);
  });
  test("[unit] company / email are trimmed, email lowercased", () => {
    const c = new Client({ company: "  Acme  ", email: "  JOHN@ACME.COM " });
    expect(c.company).toBe("Acme");
    expect(c.email).toBe("john@acme.com");
  });
  test("[unit] active rejects a non-boolean string", () => {
    const err = new Client({ company: "X", active: "maybe" }).validateSync();
    expect(err && err.errors.active).toBeDefined();
  });
  test("[unit] phoneE164 shadow is computed on save", async () => {
    const c = await Client.create({ company: "Phone Co", phonenumber: "98765 43210", tenant_id: A.tenantId });
    expect(c.phoneE164).toBe("+919876543210");
  });
  // Enforced in the controller (no DB unique index yet — see "Needs DB change").
  test("[unit] company name is unique per tenant (duplicate in same tenant rejected)", async () => {
    expect((await call(ctrl.createClient, { user: userA, body: { company: "UniqueCo" } })).statusCode).toBe(201);
    expect((await call(ctrl.createClient, { user: userA, body: { company: " uniqueco " } })).statusCode).toBe(409);
  });
  test("[unit] ClientGroup name may repeat across tenants (unique only per tenant)", async () => {
    await ClientGroup.create({ name: "VIP-unit", tenant_id: A.tenantId });
    await expect(ClientGroup.create({ name: "VIP-unit", tenant_id: B.tenantId })).resolves.toBeDefined();
  });
});

describe("createClient / updateClient / deleteClient", () => {
  test("[unit] create always sets tenant_id + created_by from the logged-in user", async () => {
    const r = await call(ctrl.createClient, { user: userA, body: { company: "Ctrl Co", tenant_id: String(B.tenantId) } });
    expect(r.statusCode).toBe(201);
    expect(String(r.body.tenant_id)).toBe(String(A.tenantId));
    expect(String(r.body.created_by)).toBe(String(A.admin.id));
  });
  test("[unit] create with a missing company returns 400 (validation), not 500", async () => {
    const r = await call(ctrl.createClient, { user: userA, body: {} });
    expect(r.statusCode).toBe(400);
  });
  test("[unit] update keeps tenant_id even if the body sends another one", async () => {
    const c = await Client.create({ company: "Upd Co", tenant_id: A.tenantId });
    await call(ctrl.updateClient, { user: userA, params: { id: String(c._id) }, body: { company: "Upd Co 2", tenant_id: String(B.tenantId) } });
    const db = await Client.findById(c._id);
    expect(db.company).toBe("Upd Co 2");
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });
  test("[unit] delete removes the client and its contacts", async () => {
    const c = await Client.create({ company: "Del Co", tenant_id: A.tenantId });
    await Contact.create({ userid: c._id, firstname: "a", lastname: "b", email: "del@x.com" });
    const r = await call(ctrl.deleteClient, { user: userA, params: { id: String(c._id) } });
    expect(r.statusCode).toBe(200);
    expect(await Client.findById(c._id)).toBeNull();
    expect(await Contact.countDocuments({ userid: c._id })).toBe(0);
  });
});

describe("getClients list filters", () => {
  let T, user, branch1;
  beforeAll(async () => {
    T = await seedCompany("ListT", ["Customers"]);
    user = await mongoose.model("Staff").findById(T.admin.id);
    branch1 = await HRMSBranch.create({ name: "Surat", tenant_id: T.tenantId });
    const docs = [];
    for (let i = 0; i < 30; i++) {
      docs.push({ company: `List ${String(i).padStart(2, "0")}`, active: i % 3 !== 0, tenant_id: T.tenantId, branch: i < 5 ? branch1._id : null });
    }
    docs.push({ company: "Needle Industries", email: "needle@x.com", active: true, tenant_id: T.tenantId });
    await Client.insertMany(docs);
  });
  const list = (query) => call(ctrl.getClients, { user, query });

  test("[unit] no page/limit/search -> bare array of all tenant customers", async () => {
    const r = await list({});
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(31);
  });
  test("[unit] page/limit paginate and counts are correct", async () => {
    const r = await list({ page: "2", limit: "10" });
    expect(r.body.data.length).toBe(10);
    expect(r.body.total).toBe(31);
    expect(r.body.pages).toBe(4);
    expect(r.body.activeCount).toBe(21);
    expect(r.body.inactiveCount).toBe(10);
  });
  test("[unit] limit is clamped to 500 and at least 1", async () => {
    expect((await list({ limit: "99999" })).body.limit).toBe(500);
    expect((await list({ limit: "0" })).body.limit).toBe(25); // 0 -> default 25
  });
  test("[unit] search matches company (case-insensitive) and email", async () => {
    expect((await list({ search: "needle" })).body.total).toBe(1);
    expect((await list({ search: "NEEDLE@X" })).body.total).toBe(1);
  });
  test("[unit] search with regex characters does not crash", async () => {
    const r = await list({ search: "(.*[" });
    expect(r.statusCode).toBe(200);
    expect(r.body.total).toBe(0);
  });
  test("[unit] search matches branch name", async () => {
    expect((await list({ search: "Surat" })).body.total).toBe(5);
  });
  test("[unit] status=Active / Inactive filter", async () => {
    expect((await list({ status: "Active", page: "1" })).body.total).toBe(21);
    expect((await list({ status: "Inactive", page: "1" })).body.total).toBe(10);
  });
  test("[unit] status=Lead must not return every customer (UI offers a 'Lead' option)", async () => {
    const r = await list({ status: "Lead", page: "1" });
    // There is no lead state on Client; the filter is silently ignored and returns ALL rows.
    expect(r.body.total).toBe(0);
  });
  test("[unit] branch filter", async () => {
    expect((await list({ branch: String(branch1._id), page: "1" })).body.total).toBe(5);
  });
  test("[unit] invalid branch id returns 400, not 500", async () => {
    const r = await list({ branch: "abc", page: "1" });
    expect(r.statusCode).toBe(400);
  });
  test("[unit] own-scope user only sees customers they own", async () => {
    const r = await call(ctrl.getClients, { user: await mongoose.model("Staff").findById(T.viewOnly.id), query: { page: "1" }, permissionLevel: "own" });
    expect(r.body.total).toBe(0);
  });
});

describe("importClients", () => {
  let T, user;
  beforeAll(async () => {
    T = await seedCompany("ImpT", ["Customers"]);
    user = await mongoose.model("Staff").findById(T.admin.id);
  });
  const imp = (body) => call(ctrl.importClients, { user, body });

  test("[unit] imports 3 rows and reports 3 new", async () => {
    const r = await imp([{ "Company Name": "Imp 1" }, { "Company Name": "Imp 2" }, { company: "Imp 3" }]);
    expect(r.statusCode).toBe(200);
    expect(r.body.insertedCount).toBe(3);
    expect(await Client.countDocuments({ tenant_id: T.tenantId })).toBe(3);
  });
  test("[unit] re-importing existing companies creates nothing new (case-insensitive)", async () => {
    const r = await imp([{ "Company Name": "imp 1" }]);
    expect(r.body.insertedCount).toBe(0);
    expect(await Client.countDocuments({ tenant_id: T.tenantId })).toBe(3);
  });
  test("[unit] duplicate rows inside ONE file create only one customer", async () => {
    await imp([{ "Company Name": "Dup Row" }, { "Company Name": "Dup Row" }]);
    expect(await Client.countDocuments({ tenant_id: T.tenantId, company: "Dup Row" })).toBe(1);
  });
  test("[unit] blank Company rows are skipped", async () => {
    const r = await imp([{ "Company Name": "" }, { "Company Name": "Blank Ok" }]);
    expect(r.body.insertedCount).toBe(1);
  });
  test("[unit] PAN is not filled from the 'Company Name' column when no PAN column exists", async () => {
    await imp([{ "Company Name": "NoPan Co" }]);
    const c = await Client.findOne({ tenant_id: T.tenantId, company: "NoPan Co" });
    // getFieldContaining(..., "pan") matches the key "company" (com-PAN-y).
    expect(c.pan_number || "").toBe("");
  });
  test("[unit] the response 'count' equals new customers only", async () => {
    const r = await imp([{ "Company Name": "Imp 1" }, { "Company Name": "Brand New" }]);
    expect(r.body.count).toBe(1);
  });
});

describe("bulkDeleteClients / transferOrAssignCustomers", () => {
  test("[unit] bulk-delete deletes only the selected ids of the caller's tenant", async () => {
    const [a1, a2, a3] = await Client.insertMany([1, 2, 3].map((i) => ({ company: `BD ${i}`, tenant_id: A.tenantId })));
    const b1 = await Client.create({ company: "BD B", tenant_id: B.tenantId });
    const r = await call(ctrl.bulkDeleteClients, { user: userA, body: { ids: [a1._id, a2._id, b1._id] } });
    expect(r.body.deletedCount).toBe(2);
    expect(await Client.findById(a3._id)).not.toBeNull();
    expect(await Client.findById(b1._id)).not.toBeNull();
  });
  test("[unit] bulk-delete with empty ids -> 400", async () => {
    expect((await call(ctrl.bulkDeleteClients, { user: userA, body: { ids: [] } })).statusCode).toBe(400);
  });
  test("[unit] transfer-or-assign adds the staff as admin + sales person on selected clients", async () => {
    const c = await Client.create({ company: "TA 1", tenant_id: A.tenantId });
    const r = await call(ctrl.transferOrAssignCustomers, { user: userA, body: { toStaffId: String(A.full.id), clientIds: [String(c._id)], sync: false } });
    expect(r.statusCode).toBe(200);
    const db = await Client.findById(c._id);
    expect(db.admins.map((a) => String(a.staff))).toContain(String(A.full.id));
    expect(String(db.sales_person)).toBe(String(A.full.id));
  });
  test("[unit] transfer mode moves sales_person from old staff to new staff", async () => {
    const c = await Client.create({ company: "TA 2", tenant_id: A.tenantId, sales_person: A.viewOnly.id });
    await call(ctrl.transferOrAssignCustomers, { user: userA, body: { fromStaffId: String(A.viewOnly.id), toStaffId: String(A.full.id) } });
    expect(String((await Client.findById(c._id)).sales_person)).toBe(String(A.full.id));
  });
  test("[unit] transfer to a staff of another tenant -> 404", async () => {
    const r = await call(ctrl.transferOrAssignCustomers, { user: userA, body: { toStaffId: String(B.full.id), clientIds: [] } });
    expect(r.statusCode).toBe(404);
  });
});

describe("getStatement totals", () => {
  test("[unit] totals: invoiced - paid = balance", async () => {
    const c = await Client.create({ company: "Stmt Co", tenant_id: A.tenantId });
    const i1 = await Invoice.create({ client: c._id, number: "U-INV-1", total: 1000, subtotal: 1000, tenant_id: A.tenantId, date: new Date("2026-01-10") });
    await Invoice.create({ client: c._id, number: "U-INV-2", total: 500, subtotal: 500, tenant_id: A.tenantId, date: new Date("2026-02-10") });
    await Payment.create({ invoice: i1._id, amount: 300, date: new Date("2026-01-20") });
    const r = await call(ctrl.getStatement, { user: userA, params: { id: String(c._id) }, query: { from: "2026-01-01", to: "2026-12-31" } });
    expect(r.body.totalInvoiced).toBe(1500);
    expect(r.body.totalPaid).toBe(300);
    expect(r.body.balanceDue).toBe(1200);
    expect(r.body.beginningBalance).toBe(0);
  });
  test("[unit] cancelled / draft invoices are not counted in the balance", async () => {
    const c = await Client.create({ company: "Stmt Cancel", tenant_id: A.tenantId });
    await Invoice.create({ client: c._id, number: "U-INV-3", total: 1000, subtotal: 1000, status: "cancelled", tenant_id: A.tenantId, date: new Date("2026-03-01") });
    await Invoice.create({ client: c._id, number: "U-INV-4", total: 700, subtotal: 700, status: "draft", tenant_id: A.tenantId, date: new Date("2026-03-01") });
    const r = await call(ctrl.getStatement, { user: userA, params: { id: String(c._id) }, query: { from: "2026-01-01", to: "2026-12-31" } });
    expect(r.body.balanceDue).toBe(0);
  });
});
