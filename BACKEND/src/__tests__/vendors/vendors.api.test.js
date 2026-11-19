// POSITIVE + NEGATIVE API tests for /api/vendors, real router on an in-memory
// MongoDB (crmTestApp refuses any non-127.0.0.1 DB). Each test states the
// CORRECT behaviour; a failing test is a bug found.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

let A, B, api, Vendor, Purchase;
const vid = () => new mongoose.Types.ObjectId();

const FULL_VENDOR = {
  company_name: "Orion Supplies Pvt Ltd",
  vendor_reference: "VEN-045",
  connect_person: "Suresh Nair",
  phone_number: "9845012345",
  address: "45 Anna Salai, Chennai, Tamil Nadu",
  email: "suresh@orionsupplies.com",
  pan_number: "AAOCS1234H",
  gst_number: "33AAOCS1234H1Z2",
  account_details: "HDFC Bank A/C 1234567890",
  sales_person: "Divya Menon",
  branch: "Chennai",
};

const dbVendor = (id) => Vendor.findById(id).lean();

beforeAll(async () => {
  await start([["/api/vendors", "routes/vendor_routes"]]);
  Vendor = require("../../models/Vendor");
  Purchase = require("../../models/Purchase");
  A = await seedCompany("A", ["Vendors"]);
  B = await seedCompany("B", ["Vendors"]);
  api = client(A.admin.token);
});
afterAll(stop);
beforeEach(async () => { await Vendor.deleteMany({}); await Purchase.deleteMany({}); });

const create = async (body) => api.post("/api/vendors", body);

// ---------------------------------------------------------------- POSITIVE
describe("POSITIVE", () => {
  test("[+] create with only Company Name", async () => {
    const r = await create({ company_name: "Only Name Co" });
    expect(r.status).toBe(201);
    const d = await dbVendor(r.body._id);
    expect(d.company_name).toBe("Only Name Co");
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });

  test("[+] create with ALL fields: API and DB match", async () => {
    const r = await create(FULL_VENDOR);
    expect(r.status).toBe(201);
    const d = await dbVendor(r.body._id);
    for (const [k, v] of Object.entries(FULL_VENDOR)) {
      expect(r.body[k]).toBe(v);
      expect(d[k]).toBe(v);
    }
    const g = await api.get(`/api/vendors/${r.body._id}`);
    expect(g.status).toBe(200);
    expect(g.body.company_name).toBe(FULL_VENDOR.company_name);
  });

  test("[+] edit every field", async () => {
    const r = await create(FULL_VENDOR);
    const edit = {
      company_name: "Orion Two", vendor_reference: "VEN-046", connect_person: "Anil",
      phone_number: "9123456780", address: "Ahmedabad, Gujarat", email: "anil@orion.in",
      pan_number: "AAOCS9999K", gst_number: "24AAOCS9999K1Z1", account_details: "SBI 999",
      sales_person: "Ravi", branch: "Ahmedabad",
    };
    const u = await api.put(`/api/vendors/${r.body._id}`, edit);
    expect(u.status).toBe(200);
    const d = await dbVendor(r.body._id);
    for (const [k, v] of Object.entries(edit)) expect(d[k]).toBe(v);
  });

  test("[+] delete", async () => {
    const r = await create({ company_name: "To Delete" });
    const d = await api.del(`/api/vendors/${r.body._id}`);
    expect(d.status).toBe(200);
    expect(await dbVendor(r.body._id)).toBeNull();
    expect((await api.get(`/api/vendors/${r.body._id}`)).status).toBe(404);
  });

  test("[+] search by company / contact / phone / GSTIN / PAN (case-insensitive)", async () => {
    await create(FULL_VENDOR);
    await create({ company_name: "Zeta Traders", connect_person: "Mahesh", phone_number: "9000000001",
      gst_number: "24ZZZZZ1111Z1Z1", pan_number: "ZZZZZ1111Z" });
    const q = async (s) => (await api.get(`/api/vendors?search=${encodeURIComponent(s)}&page=1&limit=25`)).body.data.map((v) => v.company_name);
    expect(await q("orion")).toEqual(["Orion Supplies Pvt Ltd"]);
    expect(await q("suresh")).toEqual(["Orion Supplies Pvt Ltd"]);
    expect(await q("98450")).toEqual(["Orion Supplies Pvt Ltd"]);
    expect(await q("33aaocs1234h1z2")).toEqual(["Orion Supplies Pvt Ltd"]);
    expect(await q("ZZZZZ1111Z")).toEqual(["Zeta Traders"]);
    expect(await q("  zeta  ")).toEqual(["Zeta Traders"]); // trimmed
    expect(await q("(")).toEqual([]); // regex chars escaped, no 500
  });

  test("[+] branch filter + page size + pagination", async () => {
    for (let i = 0; i < 12; i++) await create({ company_name: `V${i}`, branch: i < 5 ? "Surat" : "Rajkot" });
    const b = await api.get("/api/vendors?branch=Surat&page=1&limit=25");
    expect(b.body.total).toBe(5);
    const p1 = await api.get("/api/vendors?page=1&limit=5");
    const p3 = await api.get("/api/vendors?page=3&limit=5");
    expect(p1.body).toMatchObject({ total: 12, pages: 3, page: 1, limit: 5 });
    expect(p1.body.data).toHaveLength(5);
    expect(p3.body.data).toHaveLength(2);
    const ids = new Set([...p1.body.data, ...(await api.get("/api/vendors?page=2&limit=5")).body.data, ...p3.body.data].map((v) => v._id));
    expect(ids.size).toBe(12);
    const huge = await api.get("/api/vendors?page=1&limit=100000");
    expect(huge.body.limit).toBe(500);
  });

  test("[+] import 3 rows", async () => {
    const rows = [
      { ...FULL_VENDOR },
      { company_name: "Import Two", phone_number: "9000000002" },
      { company_name: "Import Three", email: "x@y.com" },
    ];
    const r = await api.post("/api/vendors/import", rows);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(3);
    const all = await Vendor.find({ tenant_id: A.tenantId }).lean();
    expect(all.map((v) => v.company_name).sort()).toEqual(["Import Three", "Import Two", "Orion Supplies Pvt Ltd"]);
  });

  test("[+] bulk assign Sales Person (UI sends one PUT per id)", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create({ company_name: `BA${i}` })).body._id);
    const rs = await Promise.all(ids.map((id) => api.put(`/api/vendors/${id}`, { sales_person: "Kiran" })));
    rs.forEach((r) => expect(r.status).toBe(200));
    for (const id of ids) {
      const d = await dbVendor(id);
      expect(d.sales_person).toBe("Kiran");
      expect(d.company_name).toMatch(/^BA/); // other fields untouched
    }
  });

  test("[+] mass delete selected rows", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await create({ company_name: `MD${i}` })).body._id);
    const r = await api.post("/api/vendors/bulk-delete", { ids: ids.slice(0, 3) });
    expect(r.status).toBe(200);
    expect(r.body.deletedCount).toBe(3);
    expect(await Vendor.countDocuments({})).toBe(1);
  });

  test("[+] unknown field (e.g. website) is ignored, not stored", async () => {
    const r = await create({ company_name: "W", website: "javascript:alert(1)" });
    expect(r.status).toBe(201);
    expect((await dbVendor(r.body._id)).website).toBeUndefined();
  });
});

// ---------------------------------------------------------------- NEGATIVE
const LONG = "x".repeat(500);
const XSS = '<script>alert(1)</script>';
const EMOJI = "Vendor 🚚🔥";
// Max lengths decided for the vendor form (company name 200, etc.).
const MAX = { company_name: 200, vendor_reference: 100, connect_person: 150, address: 1000, account_details: 1000, sales_person: 150, branch: 150 };
const TEXT_FIELDS = ["company_name", "vendor_reference", "connect_person", "address", "account_details", "sales_person", "branch"];

describe("NEGATIVE: generic inputs on every text field (POST + PUT)", () => {
  test("[-] company_name empty -> 400", async () => {
    const r = await create({ company_name: "" });
    expect(r.status).toBe(400);
  });
  test("[-] company_name spaces only -> 400", async () => {
    const r = await create({ company_name: "    " });
    expect(r.status).toBe(400);
  });
  test("[-] company_name missing -> 400", async () => {
    expect((await create({ phone_number: "9876543210" })).status).toBe(400);
  });
  test("[-] company_name as object (NoSQL-style) -> 400", async () => {
    expect((await create({ company_name: { $gt: "" } })).status).toBe(400);
  });
  test("[-] PUT company_name '' -> 400 and DB unchanged", async () => {
    const v = await create({ company_name: "Keep" });
    const r = await api.put(`/api/vendors/${v.body._id}`, { company_name: "" });
    expect(r.status).toBe(400);
    expect((await dbVendor(v.body._id)).company_name).toBe("Keep");
  });
  test("[-] PUT company_name spaces only -> 400", async () => {
    const v = await create({ company_name: "Keep2" });
    expect((await api.put(`/api/vendors/${v.body._id}`, { company_name: "   " })).status).toBe(400);
  });

  for (const f of TEXT_FIELDS) {
    test(`[+] ${f}: 1 char accepted`, async () => {
      const r = await create({ company_name: "C", [f]: "Q" });
      expect(r.status).toBe(201);
      expect((await dbVendor(r.body._id))[f]).toBe("Q");
    });
    test(`[+] ${f}: exactly max length (${MAX[f]}) accepted intact`, async () => {
      const r = await create({ company_name: "C", [f]: "x".repeat(MAX[f]) });
      expect(r.status).toBe(201);
      expect((await dbVendor(r.body._id))[f]).toHaveLength(MAX[f]);
    });
    test(`[-] ${f}: 500 chars -> accepted only if within max length, else 400`, async () => {
      const r = await create({ company_name: f === "company_name" ? LONG : "C", [f]: LONG });
      expect(r.status).toBe(500 <= MAX[f] ? 201 : 400);
    });
    test(`[+] ${f}: emoji stored intact`, async () => {
      const r = await create({ company_name: "C", [f]: EMOJI });
      expect(r.status).toBe(201);
      expect((await dbVendor(r.body._id))[f]).toBe(EMOJI);
    });
    test(`[-] ${f}: <script> rejected or sanitised on POST (stored XSS)`, async () => {
      const r = await create({ company_name: "C", [f]: XSS });
      if (r.status === 201) expect((await dbVendor(r.body._id))[f]).not.toMatch(/<script/i);
      else expect(r.status).toBe(400);
    });
    test(`[-] ${f}: <script> rejected or sanitised on PUT`, async () => {
      const v = await create({ company_name: "C" });
      const r = await api.put(`/api/vendors/${v.body._id}`, { [f]: XSS });
      if (r.status === 200) expect((await dbVendor(v.body._id))[f]).not.toMatch(/<script/i);
      else expect(r.status).toBe(400);
    });
  }

  test("[-] duplicate company name in same tenant -> 409/400", async () => {
    await create({ company_name: "Dup Pvt Ltd" });
    const r = await create({ company_name: "dup pvt ltd " });
    expect([400, 409]).toContain(r.status);
    expect(await Vendor.countDocuments({ tenant_id: A.tenantId })).toBe(1);
  });

  test("[+] same company name in a DIFFERENT tenant is allowed", async () => {
    await create({ company_name: "Shared Name" });
    const r = await client(B.admin.token).post("/api/vendors", { company_name: "Shared Name" });
    expect(r.status).toBe(201);
  });
});

describe("NEGATIVE: format fields", () => {
  const bad = (field, value) => test(`[-] ${field} = ${JSON.stringify(value)} -> 400 (POST)`, async () => {
    const r = await create({ company_name: "Fmt", [field]: value });
    expect(r.status).toBe(400);
  });
  const badPut = (field, value) => test(`[-] ${field} = ${JSON.stringify(value)} -> 400 (PUT)`, async () => {
    const v = await create({ company_name: "FmtPut" });
    const r = await api.put(`/api/vendors/${v.body._id}`, { [field]: value });
    expect(r.status).toBe(400);
  });

  ["98765abcde", "123", "12345678901234567890"].forEach((p) => { bad("phone_number", p); badPut("phone_number", p); });
  ["abc", "a@b"].forEach((e) => { bad("email", e); badPut("email", e); });
  ["24AAOCS1234H1Z", "24AAOCS1234H1Z22", "40AAOCS1234H1Z2", "ABAAOCS1234H1Z2"].forEach((g) => { bad("gst_number", g); badPut("gst_number", g); });
  ["AAOCS1234", "AAOCS1234HH", "1234567890", "AAOC51234H"].forEach((p) => { bad("pan_number", p); badPut("pan_number", p); });

  test("[-] PAN inside GSTIN differs from PAN field -> 400", async () => {
    const r = await create({ company_name: "Mismatch", pan_number: "AAOCS1234H", gst_number: "24BBBBB9999B1Z5" });
    expect(r.status).toBe(400);
  });

  test("[+] PAN lowercase accepted and stored uppercase", async () => {
    const r = await create({ company_name: "Low", pan_number: "aaocs1234h" });
    expect(r.status).toBe(201);
    expect((await dbVendor(r.body._id)).pan_number).toBe("AAOCS1234H");
  });
  test("[+] valid email is stored lowercased", async () => {
    const r = await create({ company_name: "Mail", email: "Raj@Example.COM" });
    expect((await dbVendor(r.body._id)).email).toBe("raj@example.com");
  });
  test("[+] valid 10-digit phone accepted", async () => {
    expect((await create({ company_name: "Ph", phone_number: "9876543210" })).status).toBe(201);
  });
});

describe("NEGATIVE: branch references", () => {
  // Decision: branch stays free text for a company with no HRMS branches; once the
  // company has HRMS branches only its own branch names are accepted.
  const branches = () => mongoose.connection.db.collection("hrmsbranches");
  afterEach(() => branches().deleteMany({}));

  test("[+] company without HRMS branches: free-text branch accepted", async () => {
    expect((await create({ company_name: "FreeText", branch: "Anything" })).status).toBe(201);
  });
  test("[-] branch that only exists in Tenant B -> 400", async () => {
    await branches().insertMany([
      { name: "A Main", tenant_id: A.tenantId, status: "Active" },
      { name: "B-Only Branch", tenant_id: B.tenantId, status: "Active" },
    ]);
    const r = await create({ company_name: "BranchX", branch: "B-Only Branch" });
    expect(r.status).toBe(400);
  });
  test("[+] own HRMS branch accepted (case-insensitive, stored with canonical name)", async () => {
    await branches().insertOne({ name: "A Main", tenant_id: A.tenantId, status: "Active" });
    const r = await create({ company_name: "BranchOk", branch: "a main" });
    expect(r.status).toBe(201);
    expect((await dbVendor(r.body._id)).branch).toBe("A Main");
  });
  test("[-] PUT to a branch outside the company's HRMS branches -> 400", async () => {
    await branches().insertOne({ name: "A Main", tenant_id: A.tenantId, status: "Active" });
    const v = await create({ company_name: "BranchPut" });
    expect((await api.put(`/api/vendors/${v.body._id}`, { branch: "Nowhere" })).status).toBe(400);
  });
});

describe("NEGATIVE: protected fields in body", () => {
  const spoof = async () => {
    const fakeId = vid();
    const r = await create({
      company_name: "Spoof", tenant_id: String(B.tenantId), _id: String(fakeId),
      createdAt: "2000-01-01T00:00:00.000Z", created_by: String(B.admin.id),
    });
    expect(r.status).toBe(201);
    return { d: await dbVendor(r.body._id), fakeId };
  };
  test("[-] POST body tenant_id ignored", async () => {
    const { d } = await spoof();
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });
  test("[-] POST body _id ignored (server generates id)", async () => {
    const { d, fakeId } = await spoof();
    expect(String(d._id)).not.toBe(String(fakeId));
  });
  test("[-] POST body createdAt ignored", async () => {
    const { d } = await spoof();
    expect(new Date(d.createdAt).getFullYear()).not.toBe(2000);
  });
  test("[-] POST body created_by ignored", async () => {
    const { d } = await spoof();
    expect(String(d.created_by)).toBe(String(A.admin.id));
  });

  test("[-] PUT body tenant_id must NOT move the vendor to another tenant", async () => {
    const v = await create({ company_name: "Mover" });
    await api.put(`/api/vendors/${v.body._id}`, { tenant_id: String(B.tenantId) });
    const d = await dbVendor(v.body._id);
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });

  test("[-] PUT body createdAt ignored", async () => {
    const v = await create({ company_name: "Stamp" });
    await api.put(`/api/vendors/${v.body._id}`, { createdAt: "2000-01-01T00:00:00.000Z" });
    expect(new Date((await dbVendor(v.body._id)).createdAt).getFullYear()).not.toBe(2000);
  });
  test("[-] PUT body created_by ignored", async () => {
    const v = await create({ company_name: "Stamp2" });
    await api.put(`/api/vendors/${v.body._id}`, { created_by: String(B.admin.id) });
    expect(String((await dbVendor(v.body._id)).created_by)).toBe(String(A.admin.id));
  });

  test("[-] import row with tenant_id / _id: tenant forced, _id ignored", async () => {
    const fakeId = vid();
    const r = await api.post("/api/vendors/import", [{ company_name: "ImpSpoof", tenant_id: String(B.tenantId), _id: String(fakeId) }]);
    expect(r.status).toBe(201);
    const d = await Vendor.findOne({ company_name: "ImpSpoof" }).lean();
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
    expect(String(d._id)).not.toBe(String(fakeId));
  });
});

describe("NEGATIVE: ids and auth", () => {
  const routes = [
    ["get", "/api/vendors/abc"],
    ["put", "/api/vendors/abc", { company_name: "x" }],
    ["del", "/api/vendors/abc"],
    ["get", "/api/vendors/abc/purchases"],
    ["post", "/api/vendors/bulk-delete", { ids: ["abc"] }],
  ];
  for (const [m, p, b] of routes) {
    test(`[-] invalid id: ${m.toUpperCase()} ${p} -> 400/404, never 500`, async () => {
      const r = await api[m](p, b);
      expect([400, 404]).toContain(r.status);
    });
  }
  test("[-] valid but unknown id -> 404", async () => {
    expect((await api.get(`/api/vendors/${vid()}`)).status).toBe(404);
    expect((await api.put(`/api/vendors/${vid()}`, { company_name: "x" })).status).toBe(404);
    expect((await api.del(`/api/vendors/${vid()}`)).status).toBe(404);
  });
  test("[-] no token / bad token -> 401 on every endpoint", async () => {
    for (const tok of [null, "not-a-jwt"]) {
      const c = client(tok);
      expect((await c.get("/api/vendors")).status).toBe(401);
      expect((await c.post("/api/vendors", { company_name: "x" })).status).toBe(401);
      expect((await c.put(`/api/vendors/${vid()}`, {})).status).toBe(401);
      expect((await c.del(`/api/vendors/${vid()}`)).status).toBe(401);
      expect((await c.post("/api/vendors/import", [{ company_name: "x" }])).status).toBe(401);
      expect((await c.post("/api/vendors/bulk-delete", { ids: [String(vid())] })).status).toBe(401);
    }
    expect(await Vendor.countDocuments({})).toBe(0);
  });
  test("[-] bulk-delete with empty ids -> 400", async () => {
    expect((await api.post("/api/vendors/bulk-delete", { ids: [] })).status).toBe(400);
  });
});

describe("NEGATIVE: import", () => {
  test("[-] empty array -> 400", async () => {
    expect((await api.post("/api/vendors/import", [])).status).toBe(400);
  });
  test("[-] non-array body -> 400", async () => {
    expect((await api.post("/api/vendors/import", { company_name: "x" })).status).toBe(400);
  });
  test("[-] rows missing company_name column -> nothing created, 400 or count 0", async () => {
    const r = await api.post("/api/vendors/import", [{ phone_number: "1" }, { email: "a@b.com" }]);
    expect(r.status).not.toBe(500);
    expect(r.body.count).toBe(0);
    expect(await Vendor.countDocuments({})).toBe(0);
  });
  test("[-] one spaces-only company row must be skipped, other rows still imported", async () => {
    const r = await api.post("/api/vendors/import", [{ company_name: "Good One" }, { company_name: "   " }]);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(1);
    expect(await Vendor.countDocuments({ company_name: "Good One" })).toBe(1);
  });
  test("[-] duplicates inside one file -> imported once", async () => {
    await api.post("/api/vendors/import", [{ company_name: "Twin" }, { company_name: "Twin" }]);
    expect(await Vendor.countDocuments({ company_name: "Twin" })).toBe(1);
  });
  test("[-] same file imported twice -> no duplicates", async () => {
    const rows = [{ company_name: "Again 1" }, { company_name: "Again 2" }];
    await api.post("/api/vendors/import", rows);
    const r2 = await api.post("/api/vendors/import", rows);
    expect(await Vendor.countDocuments({})).toBe(2);
    expect(r2.body.count).toBe(0);
  });
  test("[-] invalid email/GST in an import row -> row skipped", async () => {
    await api.post("/api/vendors/import", [{ company_name: "BadRow", email: "abc", gst_number: "123" }]);
    expect(await Vendor.countDocuments({ company_name: "BadRow" })).toBe(0);
  });
});

describe("NEGATIVE: double submit / delete with bills", () => {
  test("[-] double-submit create -> one record", async () => {
    const body = { company_name: "Double Click Co", phone_number: "9876543210" };
    const [r1, r2] = await Promise.all([create(body), create(body)]);
    expect([r1.status, r2.status].filter((s) => s === 201)).toHaveLength(1);
    expect(await Vendor.countDocuments({ company_name: "Double Click Co" })).toBe(1);
  });

  test("[-] deleting a vendor that has purchase bills is blocked (400/409), bills keep a valid vendor", async () => {
    const v = await create({ company_name: "Has Bills" });
    await Purchase.create({ bill_no: "PB-1", supplier_name: "Has Bills", vendor_id: v.body._id, amount: 100, total: 118, tenant_id: A.tenantId });
    const r = await api.del(`/api/vendors/${v.body._id}`);
    expect([400, 409]).toContain(r.status);
    expect(await dbVendor(v.body._id)).not.toBeNull();
  });

  test("[-] bulk-delete mix: vendors without bills deleted, ones with bills skipped and reported", async () => {
    const keep = await create({ company_name: "Billed" });
    const gone = await create({ company_name: "No Bills" });
    await Purchase.create({ bill_no: "PB-3", supplier_name: "Billed", vendor_id: keep.body._id, amount: 1, total: 1, tenant_id: A.tenantId });
    const r = await api.post("/api/vendors/bulk-delete", { ids: [keep.body._id, gone.body._id] });
    expect(r.status).toBe(200);
    expect(r.body.deletedCount).toBe(1);
    expect(r.body.skipped.map((s) => s.company_name)).toEqual(["Billed"]);
    expect(await dbVendor(keep.body._id)).not.toBeNull();
    expect(await dbVendor(gone.body._id)).toBeNull();
  });

  test("[-] PUT rename to another vendor's name (case-insensitive) -> 409", async () => {
    await create({ company_name: "First Co" });
    const v = await create({ company_name: "Second Co" });
    expect((await api.put(`/api/vendors/${v.body._id}`, { company_name: " first co" })).status).toBe(409);
  });

  test("[-] bulk-deleting a vendor that has purchase bills is blocked", async () => {
    const v = await create({ company_name: "Has Bills 2" });
    await Purchase.create({ bill_no: "PB-2", supplier_name: "Has Bills 2", vendor_id: v.body._id, amount: 100, total: 118, tenant_id: A.tenantId });
    await api.post("/api/vendors/bulk-delete", { ids: [v.body._id] });
    expect(await dbVendor(v.body._id)).not.toBeNull();
  });
});
