// Customers module — NEGATIVE API tests for every field (POST and PUT) + auth / ids / import / files.
// In-memory MongoDB only. Each test states the CORRECT behaviour; a failure = a bug.
// Convention: "rejected" = 4xx (never 500) and nothing saved.
jest.setTimeout(120000);

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

let baseUrl, A, B, api, Client, ClientGroup, HRMSBranch;
const uploadedKeys = [];
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
const N = (n, ch = "a") => ch.repeat(n);
const XSS = "<script>alert(1)</script>";

const uploadFile = async (token, clientId, name, content, type) => {
  const fd = new FormData();
  fd.append("files", new Blob([content], { type }), name);
  const res = await fetch(`${baseUrl}/api/clients/${clientId}/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = await res.json().catch(() => null);
  if (Array.isArray(body)) body.forEach((f) => f.attachment_key && uploadedKeys.push(f.attachment_key));
  return { status: res.status, body };
};

let seq = 0;
const uniq = () => `NegCo ${++seq}`;

// POST {company, [field]: value} -> must be rejected (4xx) and not saved.
const expectRejectedOnCreate = async (field, value) => {
  const company = field === "company" ? value : uniq();
  const before = await Client.countDocuments({ tenant_id: A.tenantId });
  const r = await api.post("/api/clients", { company, [field]: value });
  const after = await Client.countDocuments({ tenant_id: A.tenantId });
  return { status: r.status, saved: after - before, stored: r.body && r.body[field], body: r.body };
};
// PUT on an existing valid client -> must be rejected (4xx) and DB unchanged.
let putTarget;
const expectRejectedOnUpdate = async (field, value) => {
  const before = await Client.findById(putTarget).lean();
  const r = await api.put(`/api/clients/${putTarget}`, { company: before.company, [field]: value });
  const after = await Client.findById(putTarget).lean();
  // restore
  await Client.updateOne({ _id: putTarget }, { $set: { [field]: before[field] === undefined ? null : before[field], company: before.company } });
  return { status: r.status, changed: JSON.stringify(after[field]) !== JSON.stringify(before[field]), stored: after[field] };
};

beforeAll(async () => {
  ({ baseUrl } = await start([
    ["/api/clients", "routes/client_routes"],
    ["/api/client-groups", "routes/client_group_routes"],
  ]));
  Client = require("../../models/Client");
  ClientGroup = require("../../models/ClientGroup");
  HRMSBranch = require("../../hrms/models/hrms_branch_model");
  A = await seedCompany("A", ["Customers"]);
  B = await seedCompany("B", ["Customers"]);
  api = client(A.admin.token);
  putTarget = (await api.post("/api/clients", { company: "Put Target", email: "ok@put.com", phonenumber: "9876543210" })).body._id;
  await api.post("/api/clients", { company: "Existing Co", customer_reference: "REF-1", email: "dup@x.com", phonenumber: "9876500000" });
});
afterAll(async () => {
  for (const k of uploadedKeys) { try { fs.unlinkSync(path.join(UPLOAD_DIR, k)); } catch { /* gone */ } }
  await stop();
});

// ---------- Field table: [field, label, value] that must be REJECTED on POST and PUT ----------
const REJECT = [
  ["company", "empty", ""],
  ["company", "only spaces", "   "],
  ["company", "500 chars", N(500)],
  ["company", "<script> tag", XSS],
  ["company", "duplicate of existing (same tenant)", "Existing Co"],
  ["customer_reference", "duplicate", "REF-1"],
  ["customer_reference", "300 chars", N(300)],
  ["contact_person", "numbers only", "1234567890"],
  ["contact_person", "300 chars", N(300)],
  ["contact_person", "HTML tags", "<b>John</b><img src=x onerror=alert(1)>"],
  ["vat", "100 chars", N(100, "9")],
  ["phonenumber", "letters", "abcdefghij"],
  ["phonenumber", "3 digits", "123"],
  ["phonenumber", "20 digits", N(20, "9")],
  ["email", "abc", "abc"],
  ["email", "abc@", "abc@"],
  ["email", "@x.com", "@x.com"],
  ["email", "a@b", "a@b"],
  ["email", "spaces inside", "a b@x.com"],
  ["website", "abc", "abc"],
  ["website", "javascript:alert(1)", "javascript:alert(1)"],
  ["website", "1000 chars", "https://" + N(1000) + ".com"],
  ["pan_number", "9 chars", "ABCDE1234"],
  ["pan_number", "11 chars", "ABCDE1234FF"],
  ["pan_number", "wrong pattern", "1234ABCDEF"],
  ["gst_number", "14 chars", "27ABCDE1234F1Z"],
  ["gst_number", "16 chars", "27ABCDE1234F1Z55"],
  ["gst_number", "wrong state code 45", "45ABCDE1234F1Z5"],
  ["account_details", "HTML", XSS],
  ["address", "HTML", XSS],
  ["city", "numbers only", "123456"],
  ["city", "300 chars", N(300)],
  ["state", "numbers only", "123456"],
  ["state", "300 chars", N(300)],
  ["zip", "letters", "ABCDEF"],
  ["zip", "3 digits", "123"],
  ["zip", "12 digits", N(12, "1")],
  ["country", "HTML", "<b>India</b>"],
  ["country", "300 chars", N(300)],
  ["default_language", "300 chars", N(300)],
  ["currency", "invalid currency id", "not-a-currency"],
  ["sales_person", "random invalid id", "abc"],
  ["groups", "invalid id", ["abc"]],
  ["branch", "invalid id", "abc"],
  ["active", "null", null],
  ["active", "'maybe'", "maybe"],
];
for (const pfx of ["billing", "shipping"]) {
  REJECT.push(
    [`${pfx}_street`, "HTML", XSS],
    [`${pfx}_street`, "2001 chars", N(2001)],
    [`${pfx}_city`, "numbers only", "123456"],
    [`${pfx}_city`, "300 chars", N(300)],
    [`${pfx}_state`, "numbers only", "123456"],
    [`${pfx}_zip`, "letters", "ABCDEF"],
    [`${pfx}_zip`, "12 digits", N(12, "1")],
    [`${pfx}_country`, "HTML", "<script>x</script>"],
  );
}

describe("Every field — POST must reject bad input", () => {
  test.each(REJECT)("[-] POST %s = %s", async (field, label, value) => {
    const r = await expectRejectedOnCreate(field, value);
    expect(`${r.status} saved=${r.saved}`).toMatch(/^4\d\d saved=0$/);
  });
});

describe("Every field — PUT must reject bad input", () => {
  const PUT_REJECT = REJECT.filter(([f, l]) => !(f === "company" && l.startsWith("duplicate")))
    .concat([["company", "duplicate of existing (same tenant)", "Existing Co"]]);
  test.each(PUT_REJECT)("[-] PUT %s = %s", async (field, label, value) => {
    const r = await expectRejectedOnUpdate(field, value);
    expect(`${r.status} changed=${r.changed}`).toMatch(/^4\d\d changed=false$/);
  });
});

describe("Active coercion", () => {
  test.each([["'yes'", "yes"], ["1", 1]])("[-] active = %s -> 4xx, or stored as boolean true", async (label, value) => {
    const r = await api.post("/api/clients", { company: uniq(), active: value });
    if (r.status === 201) expect((await Client.findById(r.body._id).lean()).active).toBe(true);
    else expect(r.status).toBe(400);
  });
});

describe("Reference fields pointing at other tenants / deleted docs", () => {
  test("[-] sales_person = staff of Tenant B -> 400", async () => {
    expect((await api.post("/api/clients", { company: uniq(), sales_person: String(B.full.id) })).status).toBe(400);
  });
  test("[-] sales_person = deleted user -> 400", async () => {
    const ghost = new mongoose.Types.ObjectId();
    expect((await api.post("/api/clients", { company: uniq(), sales_person: String(ghost) })).status).toBe(400);
  });
  test("[-] groups = group of Tenant B -> 400", async () => {
    const gb = await ClientGroup.create({ name: "B only group", tenant_id: B.tenantId });
    expect((await api.post("/api/clients", { company: uniq(), groups: [String(gb._id)] })).status).toBe(400);
  });
  test("[-] groups = deleted group -> 400", async () => {
    const g = await api.post("/api/client-groups", { name: "Temp group" });
    await api.del(`/api/client-groups/${g.body._id}`);
    expect((await api.post("/api/clients", { company: uniq(), groups: [g.body._id] })).status).toBe(400);
  });
  test("[-] branch = branch of Tenant B -> 400", async () => {
    const bb = await HRMSBranch.create({ name: "B Branch", tenant_id: B.tenantId });
    const r = await api.post("/api/clients", { company: uniq(), branch: String(bb._id) });
    expect(r.status).toBe(400);
  });
});

describe("Valid-but-unusual inputs must be accepted (no false negatives)", () => {
  test.each([
    ["company", "1 char", "X"],
    ["company", "emoji", "Café 😀 Ltd"],
    ["phonenumber", "+91 with spaces/dashes", "+91 98765-43210"],
    ["email", "UPPERCASE is stored lowercase", "UPPER@X.COM"],
    ["website", "missing http", "www.acme.com"],
    ["address", "2000 chars", N(2000)],
    ["account_details", "2000 chars", N(2000)],
    ["vat", "letters+symbols", "GB-123/45"],
    ["customer_reference", "special chars", "REF#/-_.99"],
    ["pan_number", "lowercase is accepted and stored upper-case", "abcde1234f"],
  ])("[+] POST %s = %s", async (field, label, value) => {
    const r = await api.post("/api/clients", { company: field === "company" ? value : uniq(), [field]: value });
    expect(r.status).toBe(201);
    const db = await Client.findById(r.body._id).lean();
    expect(db[field]).toBe(field === "email" ? value.toLowerCase() : field === "pan_number" ? value.toUpperCase() : value);
  });
  // Decision: the same email / phone on two customers is allowed (branches of one firm share them).
  test("[+] duplicate email / phone of an existing customer is allowed", async () => {
    const e = await api.post("/api/clients", { company: uniq(), email: "dup@x.com" });
    const p = await api.post("/api/clients", { company: uniq(), phonenumber: "9876500000" });
    expect([e.status, p.status]).toEqual([201, 201]);
  });
});

describe("Auth, ids, mass assignment, double submit", () => {
  test("[-] no token -> 401", async () => {
    expect((await client(null).get("/api/clients")).status).toBe(401);
    expect((await client(null).post("/api/clients", { company: "x" })).status).toBe(401);
  });
  test("[-] bad token -> 401", async () => {
    expect((await client("not.a.jwt").get("/api/clients")).status).toBe(401);
  });
  test.each([
    ["GET", "/api/clients/abc"],
    ["PUT", "/api/clients/abc"],
    ["DELETE", "/api/clients/abc"],
    ["GET", "/api/clients/abc/contacts"],
    ["GET", "/api/clients/abc/files"],
    ["GET", "/api/clients/abc/vault"],
    ["GET", "/api/clients/abc/statement"],
    ["PUT", "/api/clients/contacts/abc"],
    ["DELETE", "/api/clients/contacts/abc"],
    ["DELETE", "/api/clients/vault/abc"],
    ["DELETE", "/api/clients/abc/files/abc"],
    ["PUT", "/api/client-groups/abc"],
    ["DELETE", "/api/client-groups/abc"],
  ])("[-] invalid id: %s %s -> 400/404, never 500", async (m, p) => {
    const r = await { GET: api.get, PUT: api.put, DELETE: api.del }[m](p, m === "PUT" ? { company: "x", name: "x" } : undefined);
    expect(`${m} ${p} -> ${r.status}`).toMatch(/-> 40[04]$/);
  });
  test("[-] POST ignores body _id, tenant_id, createdAt, created_by", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const r = await api.post("/api/clients", { company: uniq(), _id: String(fakeId), tenant_id: String(B.tenantId), createdAt: "2000-01-01T00:00:00Z", created_by: String(B.admin.id) });
    expect(r.status).toBe(201);
    const db = await Client.findById(r.body._id).lean();
    expect(String(db._id)).not.toBe(String(fakeId));
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
    expect(new Date(db.createdAt).getFullYear()).not.toBe(2000);
    expect(String(db.created_by)).toBe(String(A.admin.id));
  });
  test("[-] PUT ignores body tenant_id / created_by / createdAt", async () => {
    const c = (await api.post("/api/clients", { company: uniq() })).body;
    await api.put(`/api/clients/${c._id}`, { company: c.company, tenant_id: String(B.tenantId), created_by: String(B.admin.id), createdAt: "2000-01-01T00:00:00Z" });
    const db = await Client.findById(c._id).lean();
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
    expect(String(db.created_by)).toBe(String(A.admin.id));
    expect(new Date(db.createdAt).getFullYear()).not.toBe(2000);
  });
  test("[-] double-submit (2 identical POSTs at once) -> only one record", async () => {
    const company = "Double Submit Co";
    await Promise.all([api.post("/api/clients", { company }), api.post("/api/clients", { company })]);
    expect(await Client.countDocuments({ tenant_id: A.tenantId, company })).toBe(1);
  });
  test("[-] contact create with missing required fields -> 400 (not 500)", async () => {
    const r = await api.post(`/api/clients/${putTarget}/contacts`, { firstname: "" });
    expect(r.status).toBe(400);
  });
  test("[-] contact create with invalid email -> 400", async () => {
    const r = await api.post(`/api/clients/${putTarget}/contacts`, { firstname: "a", lastname: "b", email: "abc" });
    expect(r.status).toBe(400);
  });
  test("[-] contact create on a non-existent customer -> 404", async () => {
    const r = await api.post(`/api/clients/${new mongoose.Types.ObjectId()}/contacts`, { firstname: "a", lastname: "b", email: "ghost@x.com" });
    expect(r.status).toBe(404);
  });
  test("[-] vault entry missing server/username/password -> 400 (not 500)", async () => {
    expect((await api.post(`/api/clients/${putTarget}/vault`, {})).status).toBe(400);
  });
  test("[-] reminder without description/date -> 400", async () => {
    expect((await api.post(`/api/clients/${putTarget}/reminders`, {})).status).toBe(400);
  });
  test("[-] client group with empty name -> 400 (not 500)", async () => {
    expect((await api.post("/api/client-groups", { name: "" })).status).toBe(400);
  });
  test("[-] client group duplicate name in same tenant -> 400/409 (not 500)", async () => {
    await api.post("/api/client-groups", { name: "DupGroup" });
    expect([400, 409]).toContain((await api.post("/api/client-groups", { name: "DupGroup" })).status);
  });
});

describe("Import negatives", () => {
  let T, t;
  beforeAll(async () => { T = await seedCompany("Imp", ["Customers"]); t = client(T.admin.token); });
  test("[-] empty file -> 400", async () => {
    expect((await t.post("/api/clients/import", [])).status).toBe(400);
  });
  test("[-] missing Company column -> 400", async () => {
    expect((await t.post("/api/clients/import", [{ Email: "x@y.com" }])).status).toBe(400);
  });
  test("[-] blank Company row skipped, others imported", async () => {
    const r = await t.post("/api/clients/import", [{ "Company Name": "  " }, { "Company Name": "Real Row" }]);
    expect(r.body.insertedCount).toBe(1);
  });
  test("[-] duplicate rows in one file -> imported once", async () => {
    await t.post("/api/clients/import", [{ "Company Name": "Twin" }, { "Company Name": "twin" }]);
    expect(await Client.countDocuments({ tenant_id: T.tenantId, company: /^twin$/i })).toBe(1);
  });
  test("[-] same file twice -> second run creates 0 and does not overwrite existing data", async () => {
    const file = [{ "Company Name": "Twice Co", Email: "first@x.com" }];
    await t.post("/api/clients/import", file);
    const r2 = await t.post("/api/clients/import", [{ "Company Name": "Twice Co", Email: "second@x.com" }]);
    expect(r2.body.insertedCount).toBe(0);
    expect(await Client.countDocuments({ tenant_id: T.tenantId, company: "Twice Co" })).toBe(1);
    // "skip duplicates": an existing customer is not silently overwritten
    expect((await Client.findOne({ tenant_id: T.tenantId, company: "Twice Co" })).email).toBe("first@x.com");
  });
  test("[-] imported rows with invalid email / phone are rejected or flagged", async () => {
    const r = await t.post("/api/clients/import", [{ "Company Name": "Bad Mail Co", Email: "not-an-email", "Phone Number": "abc" }]);
    const c = await Client.findOne({ tenant_id: T.tenantId, company: "Bad Mail Co" });
    expect(c ? c.email : null).not.toBe("not-an-email");
  });
  test("[-] import with an unknown branch name must not silently create a new HRMS branch", async () => {
    const before = await HRMSBranch.countDocuments({ tenant_id: T.tenantId });
    await t.post("/api/clients/import", [{ "Company Name": "Branchy", "Branch Name": "Totally New Branch XYZ" }]);
    expect(await HRMSBranch.countDocuments({ tenant_id: T.tenantId })).toBe(before);
  });
  test("[-] 5000 rows complete without error", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ "Company Name": `Bulk ${i}` }));
    const t0 = Date.now();
    const r = await t.post("/api/clients/import", rows);
    expect(r.status).toBe(200);
    expect(r.body.insertedCount).toBe(5000);
    console.log(`[customers] 5000-row import took ${Date.now() - t0} ms`);
  });
});

describe("File upload negatives", () => {
  test.each([
    ["evil.exe", "MZ\x90\x00", "application/x-msdownload"],
    ["evil.html", "<html><script>alert(document.cookie)</script></html>", "text/html"],
    ["evil.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "image/svg+xml"],
  ])("[-] upload %s must be rejected (4xx)", async (name, content, type) => {
    const r = await uploadFile(A.admin.token, putTarget, name, content, type);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
  test("[-] very large file (30 MB) must be rejected with 413/400", async () => {
    const r = await uploadFile(A.admin.token, putTarget, "big.bin", Buffer.alloc(30 * 1024 * 1024, 1), "application/octet-stream");
    expect([400, 413]).toContain(r.status);
  });
  test("[-] upload with no file -> 400 (not 500 / not empty 201)", async () => {
    const fd = new FormData();
    const res = await fetch(`${baseUrl}/api/clients/${putTarget}/files`, { method: "POST", headers: { Authorization: `Bearer ${A.admin.token}` }, body: fd });
    expect(res.status).toBe(400);
  });
  test("[-] upload to a non-existent customer -> 404", async () => {
    const r = await uploadFile(A.admin.token, String(new mongoose.Types.ObjectId()), "a.txt", "hi", "text/plain");
    expect(r.status).toBe(404);
  });
});
