// INTEGRATION tests for /api/vendors: every endpoint, permissions (view-only /
// full / no-access), tenant isolation A vs B, and the Purchases tab totals.
// In-memory MongoDB only (crmTestApp refuses any non-127.0.0.1 DB).
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

let A, B, Vendor, Purchase;

beforeAll(async () => {
  await start([["/api/vendors", "routes/vendor_routes"]]);
  Vendor = require("../../models/Vendor");
  Purchase = require("../../models/Purchase");
  // routes use checkPermission("Vendors", ...) — vendor_routes.js:16,23
  A = await seedCompany("A", ["Vendors"]);
  B = await seedCompany("B", ["Vendors"]);
});
afterAll(stop);
beforeEach(async () => { await Vendor.deleteMany({}); await Purchase.deleteMany({}); });

const mkVendor = (tenantId, extra = {}) => Vendor.create({ company_name: "Seed Vendor", tenant_id: tenantId, ...extra });

describe("every endpoint works for admin and full-access staff", () => {
  for (const who of ["admin", "full"]) {
    test(`[+] ${who}: list, get, create, update, purchases, import, bulk-delete, delete`, async () => {
      const c = client(A[who].token);
      const cr = await c.post("/api/vendors", { company_name: `By ${who}` });
      expect(cr.status).toBe(201);
      const id = cr.body._id;
      expect((await c.get("/api/vendors")).status).toBe(200);
      expect((await c.get("/api/vendors?page=1&limit=10")).status).toBe(200);
      expect((await c.get(`/api/vendors/${id}`)).status).toBe(200);
      expect((await c.put(`/api/vendors/${id}`, { connect_person: "X" })).status).toBe(200);
      expect((await c.get(`/api/vendors/${id}/purchases`)).status).toBe(200);
      expect((await c.post("/api/vendors/import", [{ company_name: `Imp ${who}` }])).status).toBe(201);
      const imp = await Vendor.findOne({ company_name: `Imp ${who}` });
      expect((await c.post("/api/vendors/bulk-delete", { ids: [String(imp._id)] })).status).toBe(200);
      expect((await c.del(`/api/vendors/${id}`)).status).toBe(200);
      expect(await Vendor.countDocuments({})).toBe(0);
    });
  }
});

describe("PERMISSIONS: view-only staff", () => {
  let c;
  beforeAll(() => { c = client(A.viewOnly.token); });

  test("[+] view-only can list and read", async () => {
    const v = await mkVendor(A.tenantId);
    expect((await c.get("/api/vendors")).status).toBe(200);
    expect((await c.get(`/api/vendors/${v._id}`)).status).toBe(200);
    expect((await c.get(`/api/vendors/${v._id}/purchases`)).status).toBe(200);
  });
  test("[-] view-only POST create -> 403, nothing saved", async () => {
    const r = await c.post("/api/vendors", { company_name: "Viewer Made" });
    expect(r.status).toBe(403);
    expect(await Vendor.countDocuments({ company_name: "Viewer Made" })).toBe(0);
  });
  test("[-] view-only PUT -> 403, DB unchanged", async () => {
    const v = await mkVendor(A.tenantId);
    const r = await c.put(`/api/vendors/${v._id}`, { company_name: "Hacked" });
    expect(r.status).toBe(403);
    expect((await Vendor.findById(v._id)).company_name).toBe("Seed Vendor");
  });
  test("[-] view-only bulk assign sales person (PUT) -> 403", async () => {
    const v = await mkVendor(A.tenantId);
    const r = await c.put(`/api/vendors/${v._id}`, { sales_person: "Viewer" });
    expect(r.status).toBe(403);
    expect((await Vendor.findById(v._id)).sales_person).toBe("");
  });
  test("[-] view-only DELETE -> 403, record kept", async () => {
    const v = await mkVendor(A.tenantId);
    const r = await c.del(`/api/vendors/${v._id}`);
    expect(r.status).toBe(403);
    expect(await Vendor.findById(v._id)).not.toBeNull();
  });
  test("[-] view-only import -> 403, nothing saved", async () => {
    const r = await c.post("/api/vendors/import", [{ company_name: "Viewer Import" }]);
    expect(r.status).toBe(403);
    expect(await Vendor.countDocuments({ company_name: "Viewer Import" })).toBe(0);
  });
  test("[-] view-only bulk-delete -> 403, records kept", async () => {
    const v = await mkVendor(A.tenantId);
    const r = await c.post("/api/vendors/bulk-delete", { ids: [String(v._id)] });
    expect(r.status).toBe(403);
    expect(await Vendor.findById(v._id)).not.toBeNull();
  });
});

describe("PERMISSIONS: no-access staff", () => {
  test("[-] no Vendors permission -> 403 on every endpoint", async () => {
    const v = await mkVendor(A.tenantId);
    const c = client(A.noAccess.token);
    expect((await c.get("/api/vendors")).status).toBe(403);
    expect((await c.get(`/api/vendors/${v._id}`)).status).toBe(403);
    expect((await c.get(`/api/vendors/${v._id}/purchases`)).status).toBe(403);
    expect((await c.post("/api/vendors", { company_name: "n" })).status).toBe(403);
    expect((await c.put(`/api/vendors/${v._id}`, { company_name: "n" })).status).toBe(403);
    expect((await c.del(`/api/vendors/${v._id}`)).status).toBe(403);
    expect((await c.post("/api/vendors/import", [{ company_name: "n" }])).status).toBe(403);
    expect((await c.post("/api/vendors/bulk-delete", { ids: [String(v._id)] })).status).toBe(403);
    expect(await Vendor.countDocuments({})).toBe(1);
  });
});

describe("TENANT ISOLATION (A vs B)", () => {
  let a, bVendor;
  beforeEach(async () => {
    a = client(A.admin.token);
    bVendor = await mkVendor(B.tenantId, { company_name: "B Secret Vendor", gst_number: "24BBBBB1111B1Z1" });
    await Purchase.create({ bill_no: "B-BILL", supplier_name: "B Secret Vendor", vendor_id: bVendor._id, amount: 1000, total: 1180, tenant_id: B.tenantId });
  });

  test("[-] list / search never shows B's vendors", async () => {
    await mkVendor(A.tenantId, { company_name: "A Vendor" });
    const all = await a.get("/api/vendors");
    expect(all.body.map((v) => v.company_name)).toEqual(["A Vendor"]);
    const s = await a.get("/api/vendors?search=secret&page=1&limit=25");
    expect(s.body.total).toBe(0);
    const g = await a.get("/api/vendors?search=24BBBBB&page=1&limit=25");
    expect(g.body.total).toBe(0);
  });
  test("[-] A GET B's vendor -> 404", async () => {
    expect((await a.get(`/api/vendors/${bVendor._id}`)).status).toBe(404);
  });
  test("[-] A GET B's vendor purchases -> 404, no bills leaked", async () => {
    const r = await a.get(`/api/vendors/${bVendor._id}/purchases`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/B-BILL/);
  });
  test("[-] A PUT B's vendor -> 404, unchanged", async () => {
    expect((await a.put(`/api/vendors/${bVendor._id}`, { company_name: "Owned" })).status).toBe(404);
    expect((await Vendor.findById(bVendor._id)).company_name).toBe("B Secret Vendor");
  });
  test("[-] A DELETE B's vendor -> 404, kept", async () => {
    expect((await a.del(`/api/vendors/${bVendor._id}`)).status).toBe(404);
    expect(await Vendor.findById(bVendor._id)).not.toBeNull();
  });
  test("[-] A bulk-delete with B's id -> deletes 0", async () => {
    const r = await a.post("/api/vendors/bulk-delete", { ids: [String(bVendor._id)] });
    expect(r.body.deletedCount).toBe(0);
    expect(await Vendor.findById(bVendor._id)).not.toBeNull();
  });
  test("[-] A purchases tab never counts B's bills linked to A's vendor id", async () => {
    // A B-tenant bill pointing at A's vendor (bad data) must not leak into A's totals.
    const av = await mkVendor(A.tenantId);
    await Purchase.create({ bill_no: "B-CROSS", supplier_name: "x", vendor_id: av._id, amount: 5, total: 5, tenant_id: B.tenantId });
    const r = await a.get(`/api/vendors/${av._id}/purchases`);
    expect(r.body.totals.count).toBe(0);
  });
  test("[-] A cannot move own vendor into B via PUT tenant_id (would plant data in B)", async () => {
    const av = await mkVendor(A.tenantId, { company_name: "Planted" });
    await a.put(`/api/vendors/${av._id}`, { tenant_id: String(B.tenantId) });
    const bList = await client(B.admin.token).get("/api/vendors");
    expect(bList.body.map((v) => v.company_name)).not.toContain("Planted");
  });
});

describe("Purchases tab = Purchase records", () => {
  test("[+] rows (Bill Ref, Date, Taxable, GST, Total, Payment) and totals match DB", async () => {
    const c = client(A.admin.token);
    const v = await mkVendor(A.tenantId, { company_name: "Supplier X" });
    const bills = [
      { bill_no: "SX-1", bill_date: new Date("2026-05-01"), amount: 1000, cgst: 90, sgst: 90, total: 1180, payment_status: "Paid" },
      { bill_no: "SX-2", bill_date: new Date("2026-07-15"), amount: 500, igst: 90, total: 590, payment_status: "Unpaid" },
      { bill_no: "SX-3", bill_date: new Date("2026-06-20"), amount: 250.5, cgst: 22.55, sgst: 22.55, total: 296, payment_status: "Partially Paid" },
    ];
    await Purchase.create(bills.map((b) => ({ ...b, supplier_name: "Supplier X", vendor_id: v._id, tenant_id: A.tenantId })));
    await Purchase.create({ bill_no: "UNLINKED", supplier_name: "Supplier X", amount: 77, total: 77, tenant_id: A.tenantId });

    const r = await c.get(`/api/vendors/${v._id}/purchases`);
    expect(r.status).toBe(200);
    expect(r.body.purchases.map((p) => p.bill_no)).toEqual(["SX-2", "SX-3", "SX-1"]);
    const dbBills = await Purchase.find({ vendor_id: v._id, tenant_id: A.tenantId }).lean();
    for (const p of r.body.purchases) {
      const d = dbBills.find((x) => x.bill_no === p.bill_no);
      expect(new Date(p.bill_date).toISOString()).toBe(d.bill_date.toISOString());
      expect(p.amount).toBe(d.amount);
      expect(p.total).toBe(d.total);
      expect(p.payment_status).toBe(d.payment_status);
    }
    const sum = (f) => dbBills.reduce((s, b) => s + f(b), 0);
    expect(r.body.totals.count).toBe(3);
    expect(r.body.totals.taxable).toBeCloseTo(sum((b) => b.amount), 2);
    expect(r.body.totals.gst).toBeCloseTo(sum((b) => (b.cgst || 0) + (b.sgst || 0) + (b.igst || 0)), 2);
    expect(r.body.totals.total).toBeCloseTo(sum((b) => b.total), 2);
    expect(r.body.totals.outstanding).toBeCloseTo(590 + 296, 2);
  });

  test("[+] vendor with no bills -> zero totals", async () => {
    const v = await mkVendor(A.tenantId);
    const r = await client(A.admin.token).get(`/api/vendors/${v._id}/purchases`);
    expect(r.body).toEqual({ purchases: [], totals: { count: 0, taxable: 0, gst: 0, total: 0, outstanding: 0 } });
  });
});
