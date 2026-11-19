// UNIT tests for the Vendors module: Vendor model + vendor_controller functions
// called directly with fake req/res, on a throwaway in-memory MongoDB only
// (crmTestApp.start refuses anything that is not 127.0.0.1).
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop } = require("../../testUtils/crmTestApp");

let Vendor, Purchase, ctrl;
const tenantA = new mongoose.Types.ObjectId();
const tenantB = new mongoose.Types.ObjectId();
const userA = { _id: new mongoose.Types.ObjectId(), tenant_id: tenantA };

const call = async (fn, { params = {}, query = {}, body = {}, user = userA } = {}) => {
  const out = { status: 200, body: undefined };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await fn({ params, query, body, user }, res);
  return { status: out.status, body: JSON.parse(JSON.stringify(out.body ?? null)) };
};

beforeAll(async () => {
  await start([]);
  Vendor = require("../../models/Vendor");
  Purchase = require("../../models/Purchase");
  ctrl = require("../../controllers/vendor_controller");
});
afterAll(stop);
beforeEach(async () => { await Vendor.deleteMany({}); await Purchase.deleteMany({}); });

describe("Vendor model", () => {
  test("[-] company_name is required", async () => {
    await expect(Vendor.create({ tenant_id: tenantA })).rejects.toThrow(/company_name/);
  });
  test("[+] trims string fields, lowercases email, uppercases PAN/GST", async () => {
    const v = await Vendor.create({
      company_name: "  Acme  ", connect_person: " Raj ", email: " A@B.COM ",
      pan_number: " abcde1234f ", gst_number: " 24abcde1234f1z5 ", tenant_id: tenantA,
    });
    expect(v.company_name).toBe("Acme");
    expect(v.connect_person).toBe("Raj");
    expect(v.email).toBe("a@b.com");
    expect(v.pan_number).toBe("ABCDE1234F");
    expect(v.gst_number).toBe("24ABCDE1234F1Z5");
  });
  test("[+] optional string fields default to empty string", async () => {
    const v = await Vendor.create({ company_name: "X", tenant_id: tenantA });
    for (const f of ["vendor_reference", "connect_person", "phone_number", "address", "email",
      "pan_number", "gst_number", "account_details", "sales_person", "branch"]) {
      expect(v[f]).toBe("");
    }
  });
  test("[-] company_name of spaces only is rejected (trim -> required)", async () => {
    await expect(Vendor.create({ company_name: "   ", tenant_id: tenantA })).rejects.toThrow();
  });
});

describe("tenant_id always set", () => {
  // Enforced in the controller, not the schema, so legacy records without a
  // tenant are not broken on save (schema change listed as a DB decision).
  test("[-] createVendor by a user with no company -> 400, nothing saved", async () => {
    const r = await call(ctrl.createVendor, { body: { company_name: "Orphan" }, user: { _id: new mongoose.Types.ObjectId() } });
    expect(r.status).toBe(400);
    expect(await Vendor.countDocuments({ company_name: "Orphan" })).toBe(0);
  });
  test("[-] importVendors by a user with no company -> 400", async () => {
    const r = await call(ctrl.importVendors, { body: [{ company_name: "Orphan" }], user: { _id: new mongoose.Types.ObjectId() } });
    expect(r.status).toBe(400);
  });
});

describe("vendor_controller (direct)", () => {
  test("[+] createVendor sets tenant_id + created_by from req.user", async () => {
    const r = await call(ctrl.createVendor, { body: { company_name: "Acme" } });
    expect(r.status).toBe(201);
    const db = await Vendor.findById(r.body._id).lean();
    expect(String(db.tenant_id)).toBe(String(tenantA));
    expect(String(db.created_by)).toBe(String(userA._id));
  });

  test("[-] createVendor without company_name -> 400 (validation), not 500", async () => {
    const r = await call(ctrl.createVendor, { body: {} });
    expect(r.status).toBe(400);
  });

  test("[+] updateVendor changes fields", async () => {
    const v = await Vendor.create({ company_name: "Old", tenant_id: tenantA });
    const r = await call(ctrl.updateVendor, { params: { id: String(v._id) }, body: { company_name: "New", phone_number: "9876543210" } });
    expect(r.status).toBe(200);
    expect((await Vendor.findById(v._id)).company_name).toBe("New");
  });

  test("[+] deleteVendor removes the record", async () => {
    const v = await Vendor.create({ company_name: "Del", tenant_id: tenantA });
    const r = await call(ctrl.deleteVendor, { params: { id: String(v._id) } });
    expect(r.status).toBe(200);
    expect(await Vendor.findById(v._id)).toBeNull();
  });

  test("[+] getVendors: search / branch / page / limit", async () => {
    for (let i = 0; i < 30; i++) {
      await Vendor.create({ company_name: `Co ${i}`, branch: i % 2 ? "Surat" : "Vadodara", tenant_id: tenantA });
    }
    await Vendor.create({ company_name: "Other tenant", tenant_id: tenantB });
    const p1 = await call(ctrl.getVendors, { query: { page: "1", limit: "10" } });
    expect(p1.body.total).toBe(30);
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.pages).toBe(3);
    const p3 = await call(ctrl.getVendors, { query: { page: "3", limit: "10" } });
    expect(p3.body.data).toHaveLength(10);
    const s = await call(ctrl.getVendors, { query: { search: "Co 2", page: "1", limit: "50" } });
    // "Co 2", "Co 20".."Co 29" = 11
    expect(s.body.total).toBe(11);
    const b = await call(ctrl.getVendors, { query: { branch: "Surat", page: "1", limit: "50" } });
    expect(b.body.total).toBe(15);
    const all = await call(ctrl.getVendors, {});
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body).toHaveLength(30);
  });

  test("[-] getVendors: branch filter alone (no page/limit) should still filter", async () => {
    await Vendor.create({ company_name: "S1", branch: "Surat", tenant_id: tenantA });
    await Vendor.create({ company_name: "V1", branch: "Vadodara", tenant_id: tenantA });
    const r = await call(ctrl.getVendors, { query: { branch: "Surat" } });
    const rows = Array.isArray(r.body) ? r.body : r.body.data;
    expect(rows.map((v) => v.company_name)).toEqual(["S1"]);
  });

  test("[+] importVendors: counts created and skipped rows", async () => {
    const r = await call(ctrl.importVendors, { body: [{ company_name: "A" }, { company_name: "B" }, { phone_number: "1" }] });
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(2);
    expect(r.body.message).toMatch(/Imported 2 of 3/);
    expect(r.body.message).toMatch(/Row 3/);
  });

  test("[-] importVendors: a row duplicating an existing vendor should be reported as duplicate, not re-created", async () => {
    await Vendor.create({ company_name: "Dup Co", tenant_id: tenantA });
    const r = await call(ctrl.importVendors, { body: [{ company_name: "Dup Co" }, { company_name: "Fresh Co" }] });
    expect(r.body.count).toBe(1);
    expect(await Vendor.countDocuments({ company_name: "Dup Co", tenant_id: tenantA })).toBe(1);
  });

  test("[+] bulkDeleteVendors deletes only own-tenant ids", async () => {
    const a = await Vendor.create({ company_name: "A", tenant_id: tenantA });
    const b = await Vendor.create({ company_name: "B", tenant_id: tenantB });
    const r = await call(ctrl.bulkDeleteVendors, { body: { ids: [String(a._id), String(b._id)] } });
    expect(r.body.deletedCount).toBe(1);
    expect(await Vendor.findById(b._id)).not.toBeNull();
  });

  test("[+] getVendorPurchases: only this vendor's bills, newest bill_date first, totals", async () => {
    const v = await Vendor.create({ company_name: "Supplier", tenant_id: tenantA });
    const other = await Vendor.create({ company_name: "Other", tenant_id: tenantA });
    const base = { supplier_name: "Supplier", tenant_id: tenantA };
    await Purchase.create([
      { ...base, bill_no: "B1", bill_date: new Date("2026-01-10"), vendor_id: v._id, amount: 100, cgst: 9, sgst: 9, total: 118, payment_status: "Paid" },
      { ...base, bill_no: "B2", bill_date: new Date("2026-03-10"), vendor_id: v._id, amount: 200, igst: 36, total: 236 },
      { ...base, bill_no: "B3", bill_date: new Date("2026-02-10"), vendor_id: v._id, amount: 50, cgst: 4.5, sgst: 4.5, total: 59, payment_status: "Partially Paid" },
      { ...base, bill_no: "X1", bill_date: new Date("2026-04-10"), vendor_id: other._id, amount: 999, total: 999 },
    ]);
    const r = await call(ctrl.getVendorPurchases, { params: { id: String(v._id) } });
    expect(r.status).toBe(200);
    expect(r.body.purchases.map((p) => p.bill_no)).toEqual(["B2", "B3", "B1"]);
    expect(r.body.totals).toEqual({ count: 3, taxable: 350, gst: 63, total: 413, outstanding: 295 });
  });
});
