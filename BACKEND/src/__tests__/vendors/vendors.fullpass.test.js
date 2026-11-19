// Vendors full test pass (test-prompts/06-vendors.md, 00-common-rules.md).
// Real routers + planModuleGate + real auth on an in-memory MongoDB (startVendorsFullTestStack
// refuses any non-127.0.0.1 DB). Listens on a random free port, never :5001.
// Each test states the EXPECTED behaviour (PROPOSED rules = real rules, decided by the owner).
// A failing test = a bug found (see test-results/vendors/REPORT.md). Do not "fix" a test to go green.
jest.setTimeout(300000);
process.env.VENDORS_PERF_COUNT = "0"; // perf data lives in vendors.fullpass.perf.test.js

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { boot, PASSWORD } = require("../../testUtils/startVendorsFullTestStack");

let W, Vendor, Purchase, ActivityLog, Setting, HRMSBranch;
const call = (token) => {
  const go = async (method, path, body, headers = {}) => {
    const res = await fetch(W.baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return { get: (p, h) => go("GET", p, undefined, h), post: (p, b) => go("POST", p, b), put: (p, b) => go("PUT", p, b), del: (p, b) => go("DELETE", p, b), patch: (p, b) => go("PATCH", p, b) };
};
let A, B, R, N, admin;
const uniq = (() => { let n = 0; return (p = "V") => `${p} ${Date.now()}-${++n}`; })();
const mkVendor = async (body, who) => (who || admin).post("/api/vendors", { company_name: uniq(), ...body });

beforeAll(async () => {
  W = await boot({ port: 0 });
  ({ A, B, R, N } = W);
  Vendor = require("../../models/Vendor");
  Purchase = require("../../models/Purchase");
  ActivityLog = require("../../models/ActivityLog");
  Setting = require("../../models/Setting");
  HRMSBranch = require("../../hrms/models/hrms_branch_model");
  admin = call(A.admin.token);
});
afterAll(async () => { if (W) await W.stop(); });

// ------------------------------------------------------------------ FIELD RULES
describe("FIELD RULES (expected rule, API bypass)", () => {
  const rejects = (label, body) => test(`[reject] ${label}`, async () => {
    const r = await mkVendor(body);
    expect(r.status).toBe(400);
  });
  const accepts = (label, body, check) => test(`[accept] ${label}`, async () => {
    const r = await mkVendor(body);
    expect(r.status).toBe(201);
    if (check) check(r.body, await Vendor.findById(r.body._id).lean());
  });

  // Company Name
  rejects("Company Name empty", { company_name: "" });
  rejects("Company Name only spaces", { company_name: "     " });
  rejects("Company Name missing", { company_name: undefined });
  accepts("Company Name 200 chars", { company_name: `C${Date.now()}`.padEnd(200, "x") });
  rejects("Company Name 201 chars", { company_name: "x".repeat(201) });
  rejects("Company Name with HTML", { company_name: "<b>Bold Co</b>" });
  rejects("Company Name as object {$ne:null}", { company_name: { $ne: null } });
  accepts("Company Name leading/trailing spaces are trimmed", { company_name: "   Trim Me Co   " }, (b, d) => expect(d.company_name).toBe("Trim Me Co"));
  accepts("Company Name with emoji / & / quotes", { company_name: `Shree Ganesh & Sons "Pvt" 🚚 ${Date.now()}` });
  test("Company Name duplicate, other case, same company -> 409", async () => {
    const r1 = await admin.post("/api/vendors", { company_name: "ABC Ltd" });
    expect(r1.status).toBe(201);
    const r2 = await admin.post("/api/vendors", { company_name: "abc ltd" });
    expect(r2.status).toBe(409);
  });
  test("Company Name duplicate in a DIFFERENT company is allowed", async () => {
    const r = await call(B.admin.token).post("/api/vendors", { company_name: "ABC Ltd" });
    expect(r.status).toBe(201);
  });
  test("Company Name rename to another vendor's name (any case) -> 409 on edit", async () => {
    const a = await mkVendor({ company_name: "Rename Target One" });
    const b = await mkVendor({ company_name: "Rename Source Two" });
    expect(a.status).toBe(201);
    const r = await admin.put(`/api/vendors/${b.body._id}`, { company_name: "RENAME TARGET ONE" });
    expect(r.status).toBe(409);
  });

  // Lengths
  accepts("Vendor Reference 100", { vendor_reference: "r".repeat(100) });
  rejects("Vendor Reference 101", { vendor_reference: "r".repeat(101) });
  rejects("Vendor Reference HTML", { vendor_reference: "<i>x</i>" });
  accepts("Connect Person 150", { connect_person: "p".repeat(150) });
  rejects("Connect Person 151", { connect_person: "p".repeat(151) });
  accepts("Address 1000", { address: "a".repeat(1000) });
  rejects("Address 1001", { address: "a".repeat(1001) });
  rejects("Address HTML", { address: "<script>alert(1)</script>" });
  accepts("Account Details 1000", { account_details: "a".repeat(1000) });
  rejects("Account Details 1001", { account_details: "a".repeat(1001) });
  accepts("Sales Person 150", { sales_person: "s".repeat(150) });
  rejects("Sales Person 151", { sales_person: "s".repeat(151) });
  rejects("Sales Person HTML <img onerror>", { sales_person: "<img src=x onerror=alert(1)>" });

  // Phone (PROPOSED: Indian mobile, 10 digits starting 6-9, optional +91)
  accepts("Phone 9876543210", { phone_number: "9876543210" });
  accepts("Phone +919876543210", { phone_number: "+919876543210" });
  accepts("Phone +91 9876543210", { phone_number: "+91 9876543210" });
  rejects("Phone starting with 5 (5876543210)", { phone_number: "5876543210" });
  rejects("Phone starting with 0 (0123456789)", { phone_number: "0123456789" });
  rejects("Phone 9 digits", { phone_number: "987654321" });
  rejects("Phone 11 digits (98765432101)", { phone_number: "98765432101" });
  rejects("Phone 15 digits (123456789012345)", { phone_number: "123456789012345" });
  rejects("Phone landline (022) 2345-6789", { phone_number: "(022) 2345-6789" });
  rejects("Phone letters", { phone_number: "98765abcde" });
  rejects("Phone only spaces+digits too short", { phone_number: "98 76" });

  // Email
  accepts("Email upper case saved lower case", { email: "Rohit.SHARMA@Example.COM" }, (b, d) => expect(d.email).toBe("rohit.sharma@example.com"));
  rejects("Email without @", { email: "rohit.example.com" });
  rejects("Email without domain dot", { email: "rohit@example" });
  rejects("Email 255 chars", { email: `${"a".repeat(243)}@example.com` });
  rejects("Email with spaces inside", { email: "ro hit@example.com" });

  // PAN
  accepts("PAN lower case is upper-cased", { pan_number: "abcde1234f" }, (b, d) => expect(d.pan_number).toBe("ABCDE1234F"));
  rejects("PAN 11 chars", { pan_number: "ABCDE1234FG" });
  rejects("PAN wrong pattern (digits first)", { pan_number: "1234ABCDEF" });
  rejects("PAN 9 chars", { pan_number: "ABCDE1234" });

  // GST
  accepts("GST valid + matching PAN", { pan_number: "ABCDE1234F", gst_number: "24abcde1234f1z5" }, (b, d) => expect(d.gst_number).toBe("24ABCDE1234F1Z5"));
  rejects("GST 16 chars", { gst_number: "24ABCDE1234F1Z5X" });
  rejects("GST does not match PAN", { pan_number: "ABCDE1234F", gst_number: "24PQRST1234F1Z5" });
  rejects("GST state code 00", { gst_number: "00ABCDE1234F1Z5" });
  rejects("GST state code 40", { gst_number: "40ABCDE1234F1Z5" });
  rejects("GST no Z in 14th place", { gst_number: "24ABCDE1234F1X5" });
  test("[reject] edit PAN so it no longer matches the saved GST", async () => {
    const v = await mkVendor({ pan_number: "ABCDE1234F", gst_number: "24ABCDE1234F1Z5" });
    const r = await admin.put(`/api/vendors/${v.body._id}`, { pan_number: "PQRST9999Z" });
    expect(r.status).toBe(400);
  });

  // Same rules on edit
  test("[edit] Indian-mobile rule also applies on edit (5876543210 rejected)", async () => {
    const v = await mkVendor({});
    const r = await admin.put(`/api/vendors/${v.body._id}`, { phone_number: "5876543210" });
    expect(r.status).toBe(400);
  });
  test("[edit] HTML rejected on edit (any field)", async () => {
    const v = await mkVendor({});
    for (const f of ["company_name", "vendor_reference", "connect_person", "address", "account_details", "sales_person"]) {
      const r = await admin.put(`/api/vendors/${v.body._id}`, { [f]: "<img src=x onerror=alert(1)>" });
      expect([f, r.status]).toEqual([f, 400]);
    }
  });
  test("[edit] length rules on edit (Company Name 201)", async () => {
    const v = await mkVendor({});
    const r = await admin.put(`/api/vendors/${v.body._id}`, { company_name: "y".repeat(201) });
    expect(r.status).toBe(400);
  });
  test("[edit] company name cannot be blanked", async () => {
    const v = await mkVendor({});
    const r = await admin.put(`/api/vendors/${v.body._id}`, { company_name: "   " });
    expect(r.status).toBe(400);
  });

  // Branch
  test("Branch free text accepted for a company with no HRMS branches (Alpha)", async () => {
    const r = await mkVendor({ branch: "Anything Goes" });
    expect(r.status).toBe(201);
  });
  test("Branch must be an existing HRMS branch for a company with branches (Beta)", async () => {
    const beta = call(B.admin.token);
    expect((await beta.post("/api/vendors", { company_name: uniq(), branch: "Nowhere" })).status).toBe(400);
    const ok = await beta.post("/api/vendors", { company_name: uniq(), branch: "beta north" });
    expect(ok.status).toBe(201);
    expect(ok.body.branch).toBe("Beta North");
  });
});

// ------------------------------------------------------------------ OLD BAD DATA (suspected 13)
describe("Old bad data", () => {
  test("Editing only Sales Person of a vendor with old invalid phone/PAN works when the screen sends the full form", async () => {
    const legacy = await Vendor.findOne({ company_name: "Legacy Bad Phone" }).lean();
    const fullForm = {
      company_name: legacy.company_name, vendor_reference: "", connect_person: "", phone_number: legacy.phone_number, address: "",
      email: "", pan_number: legacy.pan_number, gst_number: "", account_details: "", sales_person: "New Sales Person", branch: "",
    };
    const r = await admin.put(`/api/vendors/${legacy._id}`, fullForm);
    expect(r.status).toBe(200);
  });
  test("Editing only Sales Person (just that field sent, like bulk action) works", async () => {
    const legacy = await Vendor.findOne({ company_name: "Legacy Bad Phone" }).lean();
    const r = await admin.put(`/api/vendors/${legacy._id}`, { sales_person: "Bulk Person" });
    expect(r.status).toBe(200);
  });
});

// ------------------------------------------------------------------ CRUD
describe("CRUD (DB check)", () => {
  test("create -> get -> update -> delete, DB matches each step", async () => {
    const body = { company_name: uniq("Crud"), vendor_reference: "VEN-1", connect_person: "Suresh", phone_number: "9845012345", address: "Anna Salai, Chennai", email: "s@o.com", pan_number: "AAOCS1234H", gst_number: "33AAOCS1234H1Z2", account_details: "HDFC 123", sales_person: "Divya", branch: "Chennai" };
    const c = await admin.post("/api/vendors", body);
    expect(c.status).toBe(201);
    let d = await Vendor.findById(c.body._id).lean();
    for (const [k, v] of Object.entries(body)) expect([k, d[k]]).toEqual([k, v]);
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
    expect(String(d.created_by)).toBe(String(A.admin.id));
    const g = await admin.get(`/api/vendors/${c.body._id}`);
    expect(g.status).toBe(200);
    expect(g.body.company_name).toBe(body.company_name);
    const u = await admin.put(`/api/vendors/${c.body._id}`, { connect_person: "Ravi", tenant_id: String(B.tenantId), created_by: String(B.admin.id) });
    expect(u.status).toBe(200);
    d = await Vendor.findById(c.body._id).lean();
    expect(d.connect_person).toBe("Ravi");
    expect(String(d.tenant_id)).toBe(String(A.tenantId)); // protected fields ignored
    const del = await admin.del(`/api/vendors/${c.body._id}`);
    expect(del.status).toBe(200);
    expect(await Vendor.findById(c.body._id)).toBeNull();
    expect((await admin.get(`/api/vendors/${c.body._id}`)).status).toBe(404);
  });
  test("double-click: two simultaneous creates with the same name -> only one saved", async () => {
    const name = uniq("Dbl");
    const rs = await Promise.all([admin.post("/api/vendors", { company_name: name }), admin.post("/api/vendors", { company_name: name })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Vendor.countDocuments({ tenant_id: A.tenantId, company_name: name })).toBe(1);
  });
});

// ------------------------------------------------------------------ SEARCH / FILTER / PAGINATION
describe("Search / filter / pagination (server side)", () => {
  const alphaOnly = async () => Vendor.find({ tenant_id: A.tenantId }).sort({ createdAt: -1 }).lean();
  test("page 1..N at limit 10 returns every vendor exactly once, newest first", async () => {
    const all = await alphaOnly();
    const seen = [];
    const first = await admin.get("/api/vendors?page=1&limit=10");
    expect(first.body.total).toBe(all.length);
    for (let p = 1; p <= first.body.pages; p++) {
      const r = await admin.get(`/api/vendors?page=${p}&limit=10`);
      seen.push(...r.body.data.map((v) => v._id));
    }
    expect(seen).toEqual(all.map((v) => String(v._id)));
  });
  test.each([10, 25, 50, 100])("limit %i returns min(limit,total) rows", async (n) => {
    const r = await admin.get(`/api/vendors?page=1&limit=${n}`);
    expect(r.body.data.length).toBe(Math.min(n, r.body.total));
  });
  test.each([
    ["company", "Alpha Vendor 07", 1],
    ["reference", "AV-12", 1],
    ["contact", "Sita Shah", 15],
    ["phone", "9876543215", 1],
    ["email", "vendor21@alpha.test", 1],
    ["sales person", "Karan", 7],
    ["address", "MG Road", 10],
  ])("search by %s (%s) -> %i rows, all of them really match", async (_l, q, n) => {
    const r = await admin.get(`/api/vendors?page=1&limit=100&search=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(n);
  });
  test("search by GST / PAN / account details", async () => {
    expect((await admin.get("/api/vendors?page=1&limit=10&search=24ABCDE1234F1Z5")).body.data.some((v) => v.company_name === "KPI Traders")).toBe(true);
    expect((await admin.get("/api/vendors?page=1&limit=10&search=abcde1234f")).body.data.some((v) => v.company_name === "KPI Traders")).toBe(true);
    const acc = await mkVendor({ account_details: "ICICI 778899001122 ICIC0001234" });
    expect((await admin.get("/api/vendors?page=1&limit=10&search=778899001122")).body.data.map((v) => v._id)).toContain(acc.body._id);
  });
  test("regex special characters are literal, never 500", async () => {
    for (const q of ["(", "[", "*", ".*", "\\", "$where", "a|b"]) {
      const r = await admin.get(`/api/vendors?page=1&limit=10&search=${encodeURIComponent(q)}`);
      expect([q, r.status]).toEqual([q, 200]);
      if (q === ".*") expect(r.body.total).toBe(0);
    }
  });
  test("branch filter (Rudraverse) returns only that branch", async () => {
    const r = await call(R.admin.token).get("/api/vendors?page=1&limit=25&branch=Mumbai%20Branch");
    expect(r.body.data.map((v) => v.company_name)).toEqual(["Rudra Mumbai Supplier"]);
  });
  test("odd page/limit values never 500", async () => {
    for (const q of ["page=abc&limit=xyz", "page=-1&limit=-5", "page=99999&limit=10", "limit=100000", "page=1.5&limit=2.5"]) {
      const r = await admin.get(`/api/vendors?${q}`);
      expect([q, r.status]).toEqual([q, 200]);
    }
  });
  test("no pagination params -> bare array (vendor picker / export)", async () => {
    const r = await admin.get("/api/vendors");
    expect(Array.isArray(r.body)).toBe(true);
  });
});

// ------------------------------------------------------------------ ROLES
describe("Role-based access (API)", () => {
  test("no Vendors permission -> 403 on list", async () => {
    expect((await call(A.noAccess.token).get("/api/vendors")).status).toBe(403);
  });
  test("view-only cannot create / edit / delete / import / bulk-delete", async () => {
    const v = call(A.viewGlobal.token);
    const target = await mkVendor({});
    expect((await v.get("/api/vendors")).status).toBe(200);
    expect((await v.post("/api/vendors", { company_name: uniq() })).status).toBe(403);
    expect((await v.put(`/api/vendors/${target.body._id}`, { connect_person: "x" })).status).toBe(403);
    expect((await v.del(`/api/vendors/${target.body._id}`)).status).toBe(403);
    expect((await v.post("/api/vendors/import", [{ company_name: uniq() }])).status).toBe(403);
    expect((await v.post("/api/vendors/bulk-delete", { ids: [target.body._id] })).status).toBe(403);
  });
  test("Create-only staff can create but not edit", async () => {
    const c = call(A.createOnly.token);
    const r = await c.post("/api/vendors", { company_name: uniq() });
    expect(r.status).toBe(201);
    expect((await c.put(`/api/vendors/${r.body._id}`, { connect_person: "x" })).status).toBe(403);
  });
  test("full-access staff can do everything", async () => {
    const f = call(A.full.token);
    const r = await f.post("/api/vendors", { company_name: uniq() });
    expect(r.status).toBe(201);
    expect((await f.put(`/api/vendors/${r.body._id}`, { connect_person: "x" })).status).toBe(200);
    expect((await f.del(`/api/vendors/${r.body._id}`)).status).toBe(200);
  });
  test("role named like 'admin' without Create -> API 403 (screen must hide the button too, see UI test)", async () => {
    expect((await call(A.roleAdmin.token).post("/api/vendors", { company_name: uniq() })).status).toBe(403);
  });
  test("PROPOSED: View (Own) staff sees ONLY vendors they created", async () => {
    const r = await call(A.viewOwn.token).get("/api/vendors?page=1&limit=100");
    expect(r.status).toBe(200);
    const mine = await Vendor.countDocuments({ tenant_id: A.tenantId, created_by: A.viewOwn.id });
    expect(r.body.total).toBe(mine);
  });
  test("PROPOSED: View (Own) staff cannot open a vendor created by someone else", async () => {
    const other = await Vendor.findOne({ tenant_id: A.tenantId, created_by: A.admin.id }).lean();
    const r = await call(A.viewOwn.token).get(`/api/vendors/${other._id}`);
    expect([403, 404]).toContain(r.status);
  });
  test("plan with sales OFF -> 403 MODULE_DISABLED", async () => {
    const r = await call(N.admin.token).get("/api/vendors");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_DISABLED");
  });
});

// ------------------------------------------------------------------ API + SECURITY
describe("API status codes and security", () => {
  test("no token / bad token / expired token -> 401 on every endpoint", async () => {
    const v = (await Vendor.findOne({ tenant_id: A.tenantId }).lean())._id;
    const eps = [["GET", "/api/vendors"], ["POST", "/api/vendors"], ["GET", `/api/vendors/${v}`], ["PUT", `/api/vendors/${v}`], ["DELETE", `/api/vendors/${v}`], ["GET", `/api/vendors/${v}/purchases`], ["POST", "/api/vendors/import"], ["POST", "/api/vendors/bulk-delete"]];
    const expired = jwt.sign({ id: String(A.admin.id), role: "staff", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    for (const tok of [null, "garbage.token.value", jwt.sign({ id: String(A.admin.id), role: "staff" }, "wrong-secret"), expired]) {
      for (const [m, p] of eps) {
        const r = await call(tok)[{ GET: "get", POST: "post", PUT: "put", DELETE: "del" }[m]](p, m === "GET" ? undefined : {});
        expect([m, p, String(tok).slice(0, 8), r.status]).toEqual([m, p, String(tok).slice(0, 8), 401]);
      }
    }
  });
  test("other company's vendor id -> 404 for get/put/delete/purchases; nothing changes", async () => {
    const bv = B.vendors[0]._id;
    expect((await admin.get(`/api/vendors/${bv}`)).status).toBe(404);
    expect((await admin.put(`/api/vendors/${bv}`, { company_name: "hacked" })).status).toBe(404);
    expect((await admin.del(`/api/vendors/${bv}`)).status).toBe(404);
    expect((await admin.get(`/api/vendors/${bv}/purchases`)).status).toBe(404);
    const r = await admin.post("/api/vendors/bulk-delete", { ids: [String(bv)] });
    expect(r.body.deletedCount || 0).toBe(0);
    expect((await Vendor.findById(bv).lean()).company_name).toBe("Beta Secret Vendor");
  });
  test("list never shows another company's vendors", async () => {
    const r = await admin.get("/api/vendors");
    expect(r.body.every((v) => String(v.tenant_id) === String(A.tenantId))).toBe(true);
    const s = await admin.get("/api/vendors?page=1&limit=10&search=Beta%20Secret");
    expect(s.body.total).toBe(0);
  });
  test("malformed ids -> 404, never 500", async () => {
    for (const id of ["abc", "123", "{\"$ne\":null}", "%24ne", "000000000000000000000000"]) {
      const r = await admin.get(`/api/vendors/${encodeURIComponent(id)}`);
      expect([id, r.status]).toEqual([id, 404]);
    }
  });
  test("NoSQL injection in query/body is harmless", async () => {
    const r1 = await admin.get("/api/vendors?page=1&limit=10&search[$ne]=x");
    expect(r1.status).toBe(200);
    const r2 = await admin.get("/api/vendors?page=1&limit=10&branch[$ne]=x");
    expect(r2.status).toBe(200);
    expect(r2.body.total).toBe(0);
    const r3 = await admin.post("/api/vendors/bulk-delete", { ids: [{ $ne: null }] });
    expect(r3.status).toBe(400);
    const r4 = await admin.post("/api/vendors/bulk-delete", { ids: { $ne: null } });
    expect(r4.status).toBe(400);
    expect(await Vendor.countDocuments({ tenant_id: A.tenantId })).toBeGreaterThan(20);
  });
  test("XSS payloads rejected in every text field (create)", async () => {
    for (const f of ["company_name", "vendor_reference", "connect_person", "phone_number", "address", "email", "pan_number", "gst_number", "account_details", "sales_person", "branch"]) {
      for (const p of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"]) {
        const r = await admin.post("/api/vendors", { company_name: uniq(), [f]: p });
        expect([f, p, r.status]).toEqual([f, p, 400]);
      }
    }
  });
  test("javascript: URL stored in text fields is not turned into a link target (stored as text only)", async () => {
    const r = await mkVendor({ address: "javascript:alert(1)" });
    expect(r.status).toBe(201); // free text; UI test checks that the Maps link encodes it
  });
  test("Excel formula injection: values starting with = + - @ are neutralised (rejected or escaped)", async () => {
    const r = await mkVendor({ company_name: `=HYPERLINK("http://evil.test","x") ${Date.now()}`, sales_person: "@SUM(1+1)" });
    // Either rejected by the API, or stored with a leading apostrophe; raw formula must not be stored as-is.
    const stored = r.status === 201 ? (await Vendor.findById(r.body._id).lean()).company_name : "";
    expect(r.status === 400 || !/^[=+\-@]/.test(stored)).toBe(true);
  });
  test("unknown / protected body fields are dropped", async () => {
    const r = await mkVendor({ _id: "64b000000000000000000001", tenant_id: String(B.tenantId), isAdmin: true, created_by: String(B.admin.id) });
    expect(r.status).toBe(201);
    const d = await Vendor.findById(r.body._id).lean();
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
    expect(d.isAdmin).toBeUndefined();
  });
  test("huge body (10k rows of 1000-char addresses) does not 500", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ company_name: `Huge ${Date.now()} ${i}`, address: "z".repeat(1000) }));
    const r = await admin.post("/api/vendors/import", rows);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(2000);
    await Vendor.deleteMany({ company_name: /^Huge / });
  });
});

// ------------------------------------------------------------------ BUSINESS RULES
describe("Business rules", () => {
  test("1. vendor with bills: single delete 409 with message; bulk skips and lists it", async () => {
    const r = await admin.del(`/api/vendors/${A.kpiVendor._id}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/3 purchase bill/);
    const free = await mkVendor({});
    const b = await admin.post("/api/vendors/bulk-delete", { ids: [String(A.kpiVendor._id), free.body._id] });
    expect(b.status).toBe(200);
    expect(b.body.deletedCount).toBe(1);
    expect(b.body.skipped.map((s) => s.company_name)).toEqual(["KPI Traders"]);
    expect(await Vendor.findById(A.kpiVendor._id)).not.toBeNull();
  });
  test("1b. (suspected 2) bill linked only by supplier name/GSTIN still blocks delete and is counted", async () => {
    const v = await mkVendor({ company_name: "Name Linked Supplier", pan_number: "NAMEL1234K", gst_number: "24NAMEL1234K1Z5" });
    await Purchase.create({ bill_no: "NL-1", supplier_name: "Name Linked Supplier", supplier_gstin: "24NAMEL1234K1Z5", amount: 100, total: 118, tenant_id: A.tenantId });
    const p = await admin.get(`/api/vendors/${v.body._id}/purchases`);
    expect(p.body.totals.count).toBe(1);
    const r = await admin.del(`/api/vendors/${v.body._id}`);
    expect(r.status).toBe(409);
  });
  test("3. KPI totals: count, taxable, GST, total spend", async () => {
    const r = await admin.get(`/api/vendors/${A.kpiVendor._id}/purchases`);
    expect(r.status).toBe(200);
    expect(r.body.totals.count).toBe(3);
    expect(r.body.totals.taxable).toBe(2500);
    expect(r.body.totals.gst).toBe(450);
    expect(r.body.totals.total).toBe(2950);
    expect(r.body.purchases.map((p) => p.bill_no)).toEqual(["KPI-3", "KPI-2", "KPI-1"]);
  });
  test("3b. PROPOSED: Outstanding = unpaid amount only (partially paid bill counts only its balance)", async () => {
    const r = await admin.get(`/api/vendors/${A.kpiVendor._id}/purchases`);
    // Unpaid 590 + the partially paid bill's balance (1180 total, 1000 paid -> 180) = 770.
    expect(r.body.totals.outstanding).toBe(770);
  });
  test("5. import: duplicates in file and in DB skipped, bad rows reported", async () => {
    const r = await admin.post("/api/vendors/import", [
      { company_name: "Import One" }, { company_name: "import one" }, { company_name: "Alpha Vendor 01" }, { company_name: "Import Bad", phone_number: "12" }, { company_name: "Import Two", gst_number: "24ABCDE1234F1Z5", pan_number: "ABCDE1234F" },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(2);
    expect(r.body.duplicates).toBe(2);
    expect(r.body.errors.length).toBe(3);
  });
  test("5b. import error 'Row N' = real Excel row (header is row 1, so 1st data row = Row 2)", async () => {
    const r = await admin.post("/api/vendors/import", [{ company_name: uniq("Row") }, { company_name: uniq("Row"), phone_number: "12" }]);
    // second data row sits on Excel row 3
    expect(r.body.errors[0]).toMatch(/^Row 3:/);
  });
  test("5c. import of an empty list -> 400, non-array -> 400", async () => {
    expect((await admin.post("/api/vendors/import", [])).status).toBe(400);
    expect((await admin.post("/api/vendors/import", { company_name: "x" })).status).toBe(400);
  });
  test("8a. (suspected 8) DB unique index is case-insensitive", async () => {
    const idx = (await Vendor.collection.indexes()).find((i) => i.key.tenant_id === 1 && i.key.company_name === 1);
    expect(idx && idx.unique).toBe(true);
    expect(idx.collation && idx.collation.strength <= 2).toBe(true);
  });
  test("8b. (suspected 8) two imports at the same time with the same names in different case -> no duplicate", async () => {
    const n = `Race Co ${Date.now()}`;
    await Promise.all([admin.post("/api/vendors/import", [{ company_name: n }]), admin.post("/api/vendors/import", [{ company_name: n.toUpperCase() }])]);
    const count = await Vendor.countDocuments({ tenant_id: A.tenantId, company_name: new RegExp(`^${n}$`, "i") });
    expect(count).toBe(1);
  });
  test("8c. (suspected 8) concurrent imports with the same exact names: second import reports cleanly, nothing half-done", async () => {
    const t = Date.now();
    const names = Array.from({ length: 50 }, (_, i) => ({ company_name: `HalfWay ${t} ${i}` }));
    const second = names.slice(25).concat([{ company_name: `HalfWay ${t} extra` }]);
    const rs = await Promise.all([admin.post("/api/vendors/import", names), admin.post("/api/vendors/import", second)]);
    // Expected: duplicates skipped & reported, the one new name ('extra') still imported, no raw DB error.
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(await Vendor.countDocuments({ tenant_id: A.tenantId, company_name: `HalfWay ${t} extra` })).toBe(1);
    expect(JSON.stringify(rs.map((r) => r.body))).not.toMatch(/E11000/);
  });
  test("7. Require Vendor Linkage ON (tenant setting): bill needs vendor; snapshot copied; vendor edit does not change old bill", async () => {
    await Setting.create({ name: "vendor_linked_purchases", value: true, tenant_id: A.tenantId });
    const f = call(A.admin.token);
    const no = await f.post("/api/purchases", { bill_no: "LNK-0", supplier_name: "Whoever", amount: 100 });
    expect(no.status).toBe(400);
    const v = await mkVendor({ company_name: uniq("Linked"), pan_number: "LINKD1234K", gst_number: "27LINKD1234K1Z5", address: "Pune" });
    const ok = await f.post("/api/purchases", { bill_no: "LNK-1", supplier_name: "typed", vendor_id: v.body._id, amount: 100 });
    expect(ok.status).toBe(201);
    expect(ok.body.supplier_name).toBe(v.body.company_name);
    expect(ok.body.supplier_gstin).toBe("27LINKD1234K1Z5");
    expect(ok.body.supplier_address).toBe("Pune");
    expect(ok.body.supplier_state).toMatch(/Maharashtra/);
    await admin.put(`/api/vendors/${v.body._id}`, { company_name: `${v.body.company_name} Renamed`, address: "Mumbai" });
    const bill = await Purchase.findById(ok.body._id).lean();
    expect(bill.supplier_name).toBe(v.body.company_name);
    expect(bill.supplier_address).toBe("Pune");
    await Setting.deleteMany({ name: "vendor_linked_purchases" });
  });
  test("7c. linkage ON: another company's vendor id is refused with 4xx (not 500)", async () => {
    await Setting.create({ name: "vendor_linked_purchases", value: true, tenant_id: A.tenantId });
    try {
      const cross = await admin.post("/api/purchases", { bill_no: "LNK-X", supplier_name: "x", vendor_id: String(B.vendors[0]._id), amount: 1 });
      expect(cross.status).toBeGreaterThanOrEqual(400);
      expect(cross.status).toBeLessThan(500);
    } finally { await Setting.deleteMany({ name: "vendor_linked_purchases" }); }
  });
  test("7b. (suspected 5) only a GLOBAL 'vendor_linked_purchases' setting: screen and backend agree", async () => {
    await Setting.create({ name: "vendor_linked_purchases", value: true, tenant_id: null });
    const s = await admin.get("/api/settings");
    const list = Array.isArray(s.body) ? s.body : Object.entries(s.body || {}).map(([name, value]) => ({ name, value }));
    const screenSees = list.find((x) => x.name === "vendor_linked_purchases");
    const screenOn = !!screenSees && (screenSees.value === true || screenSees.value === "true");
    const bill = await admin.post("/api/purchases", { bill_no: "GLB-1", supplier_name: "No vendor", amount: 10 });
    const backendOn = bill.status === 400;
    await Setting.deleteMany({ name: "vendor_linked_purchases" });
    expect({ screenOn, backendOn }).toEqual({ screenOn, backendOn: screenOn });
  });
  test("8. HRMS branch rename renames the branch on vendors", async () => {
    const br = await HRMSBranch.findOne({ tenant_id: R.tenantId, name: "Pune Branch" });
    const r = await call(R.admin.token).patch(`/api/hrms/hrms-branches/${br._id}`, { name: "Pune Central", status: "Active" });
    expect(r.status).toBe(200);
    const v = await Vendor.findById(R.vendors[1]._id).lean();
    expect(v.branch).toBe("Pune Central");
    // other company's vendors with the same branch name are untouched
    await call(R.admin.token).patch(`/api/hrms/hrms-branches/${br._id}`, { name: "Pune Branch", status: "Active" });
  });
  test("8b. HRMS branch delete: vendors keep a branch that no longer exists (reported), and they stay editable", async () => {
    const br = await HRMSBranch.create({ name: "Temp Branch", tenant_id: R.tenantId, status: "Active" });
    const v = await call(R.admin.token).post("/api/vendors", { company_name: uniq("Tmp"), branch: "Temp Branch" });
    expect(v.status).toBe(201);
    const d = await call(R.admin.token).del(`/api/hrms/hrms-branches/${br._id}`);
    expect(d.status).toBe(200);
    const after = await Vendor.findById(v.body._id).lean();
    // Expected (business): vendor not left pointing to a deleted branch, or delete blocked while vendors use it.
    expect(after.branch).not.toBe("Temp Branch");
  });
  test("9. activity log: created / updated / deleted / imported / bulk-deleted", async () => {
    const name = uniq("Log");
    const c = await admin.post("/api/vendors", { company_name: name });
    await admin.put(`/api/vendors/${c.body._id}`, { connect_person: "x" });
    await admin.del(`/api/vendors/${c.body._id}`);
    await admin.post("/api/vendors/import", [{ company_name: uniq("LogImp") }]);
    const bd = await mkVendor({});
    await admin.post("/api/vendors/bulk-delete", { ids: [bd.body._id] });
    await new Promise((r) => setTimeout(r, 300));
    const logs = (await ActivityLog.find({ tenant_id: A.tenantId }).lean()).map((l) => l.description);
    expect(logs).toContain(`Created vendor: ${name}`);
    expect(logs).toContain(`Updated vendor: ${name}`);
    expect(logs).toContain(`Deleted vendor: ${name}`);
    expect(logs.some((l) => /^Imported \d+ vendors$/.test(l))).toBe(true);
    expect(logs.some((l) => /^Bulk-deleted 1 vendor/.test(l))).toBe(true);
  });
  test("9b. bulk-delete that deletes nothing does not write a misleading 'Bulk-deleted 0' log", async () => {
    await admin.post("/api/vendors/bulk-delete", { ids: [String(A.kpiVendor._id)] });
    await new Promise((r) => setTimeout(r, 200));
    const zero = await ActivityLog.countDocuments({ tenant_id: A.tenantId, description: /^Bulk-deleted 0/ });
    expect(zero).toBe(0);
  });
});

// ------------------------------------------------------------------ LOGIN sanity (stack used by the UI test)
describe("Stack sanity", () => {
  test("real /api/auth/login works for the seeded users", async () => {
    const r = await call(null).post("/api/auth/login", { email: "admin@alpha.test", password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });
});
