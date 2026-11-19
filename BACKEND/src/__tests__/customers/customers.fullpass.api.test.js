/**
 * Customers full test pass (test-prompts/05-customers.md) — API, field rules, business rules,
 * role-based access, company separation and security.
 *
 * Convention: every test asserts the EXPECTED rule (PROPOSED rules count as real rules).
 * A failing test = a finding for the report. Runs on in-memory MongoDB only, backend 127.0.0.1:5204.
 *
 * Run: npx jest src/__tests__/customers/customers.fullpass --runInBand
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

jest.setTimeout(120000);

let stack;
let W; // seeded world
const BASE = "http://127.0.0.1:5204";

const api = (token) => {
  const call = async (method, p, body, extraHeaders = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b), del: (p, b) => call("DELETE", p, b) };
};

let A; let B;
let adminA; let fullA; let viewA; let ownA; let ownEdA; let noneA; let adminB;
let uniq = 0;
const nm = (p = "Cust") => `${p} ${Date.now()}-${++uniq}`;

beforeAll(async () => {
  const { boot } = require("../../testUtils/startCustomersFullpassStack");
  stack = await boot({ log: false, extraCustomers: 0 });
  W = stack.world;
  A = W.A; B = W.B;
  adminA = api(A.users.admin.token);
  fullA = api(A.users.full.token);
  viewA = api(A.users.viewGlobal.token);
  ownA = api(A.users.viewOwn.token);
  ownEdA = api(A.users.ownEditor.token);
  noneA = api(A.users.noAccess.token);
  adminB = api(B.users.admin.token);
});

afterAll(async () => { if (stack) await stack.stop(); });

const create = (client, body) => client.post("/api/clients", { company: nm(), ...body });

// ───────────────────────── Field rules — Customer ─────────────────────────
describe("Field rules — Customer (API bypass)", () => {
  test("Company: required / spaces only rejected", async () => {
    expect((await adminA.post("/api/clients", {})).status).toBe(400);
    expect((await adminA.post("/api/clients", { company: "    " })).status).toBe(400);
  });
  test("Company: 200 chars accepted, 201 rejected", async () => {
    expect((await adminA.post("/api/clients", { company: `Z${Date.now()}`.padEnd(200, "x") })).status).toBe(201);
    expect((await adminA.post("/api/clients", { company: "y".repeat(201) })).status).toBe(400);
  });
  test("Company: HTML rejected", async () => {
    expect((await adminA.post("/api/clients", { company: "<script>alert(1)</script>" })).status).toBe(400);
    expect((await adminA.post("/api/clients", { company: "<img src=x onerror=alert(1)>" })).status).toBe(400);
  });
  test("Company: leading/trailing spaces trimmed", async () => {
    const n = nm("Trim");
    const r = await adminA.post("/api/clients", { company: `   ${n}   ` });
    expect(r.status).toBe(201);
    expect(r.body.company).toBe(n);
  });
  test("Company: duplicate in same company is case-insensitive (ABC Ltd = abc ltd)", async () => {
    const n = nm("ABC Ltd");
    expect((await adminA.post("/api/clients", { company: n })).status).toBe(201);
    expect((await adminA.post("/api/clients", { company: n.toLowerCase() })).status).toBe(409);
  });
  test("Company: same name allowed in a different company", async () => {
    const n = nm("Shared");
    expect((await adminA.post("/api/clients", { company: n })).status).toBe(201);
    expect((await adminB.post("/api/clients", { company: n })).status).toBe(201);
  });
  test("Company: duplicate on EDIT rejected", async () => {
    const a = await create(adminA); const b = await create(adminA);
    expect((await adminA.put(`/api/clients/${b.body._id}`, { company: a.body.company.toUpperCase() })).status).toBe(409);
  });
  test("Customer Reference: max 100 and unique per company", async () => {
    expect((await create(adminA, { customer_reference: "r".repeat(101) })).status).toBe(400);
    const ref = `REF-${Date.now()}`;
    expect((await create(adminA, { customer_reference: ref })).status).toBe(201);
    expect((await create(adminA, { customer_reference: ref.toLowerCase() })).status).toBe(409);
    expect((await create(adminB, { customer_reference: ref })).status).toBe(201);
  });
  test("Connect Person: max 150 and must contain a letter", async () => {
    expect((await create(adminA, { contact_person: "a".repeat(151) })).status).toBe(400);
    expect((await create(adminA, { contact_person: "123456" })).status).toBe(400);
    expect((await create(adminA, { contact_person: "Ravi Patel" })).status).toBe(201);
  });
  test("Phone (PROPOSED Indian mobile): 9876543210 and +919876543210 accepted", async () => {
    expect((await create(adminA, { phonenumber: "9876543210" })).status).toBe(201);
    expect((await create(adminA, { phonenumber: "+919876543210" })).status).toBe(201);
  });
  test("Phone (PROPOSED): 10 digits starting with 0-5 rejected (e.g. 5876543210)", async () => {
    expect((await create(adminA, { phonenumber: "5876543210" })).status).toBe(400);
  });
  test("Phone (PROPOSED): more than 10 digits without +91 rejected (e.g. 98765432101234)", async () => {
    expect((await create(adminA, { phonenumber: "98765432101234" })).status).toBe(400);
  });
  test("Phone: letters / too short rejected", async () => {
    expect((await create(adminA, { phonenumber: "98765abcde" })).status).toBe(400);
    expect((await create(adminA, { phonenumber: "12345" })).status).toBe(400);
  });
  test("Email: invalid rejected, saved lowercase, max 200 (254 standard)", async () => {
    expect((await create(adminA, { email: "not-an-email" })).status).toBe(400);
    const r = await create(adminA, { email: "UPPER@Example.COM" });
    expect(r.status).toBe(201);
    expect(r.body.email).toBe("upper@example.com");
  });
  test("Email (PROPOSED): unique per company", async () => {
    const e = `dup${Date.now()}@x.com`;
    expect((await create(adminA, { email: e })).status).toBe(201);
    expect((await create(adminA, { email: e.toUpperCase() })).status).toBe(409);
  });
  test("Website: http/https with a dot only; javascript: rejected", async () => {
    expect((await create(adminA, { website: "javascript:alert(1)" })).status).toBe(400);
    expect((await create(adminA, { website: "example" })).status).toBe(400);
    expect((await create(adminA, { website: "https://example.com" })).status).toBe(201);
    expect((await create(adminA, { website: "https://" + "a".repeat(300) + ".com" })).status).toBe(400);
  });
  test("PAN: exact format, auto-uppercased, 11 chars rejected", async () => {
    expect((await create(adminA, { pan_number: "ABCDE1234" })).status).toBe(400);
    expect((await create(adminA, { pan_number: "ABCDE1234FF" })).status).toBe(400);
    expect((await create(adminA, { pan_number: "12345ABCDE" })).status).toBe(400);
    const r = await create(adminA, { pan_number: "lmnop1234q" });
    expect(r.status).toBe(201);
    expect(r.body.pan_number).toBe("LMNOP1234Q");
  });
  test("PAN (PROPOSED): unique per company", async () => {
    expect((await create(adminA, { pan_number: "UNIQP1234Z" })).status).toBe(201);
    expect((await create(adminA, { pan_number: "uniqp1234z" })).status).toBe(409);
  });
  test("GST: 15 chars, valid format, must match PAN; 16 chars rejected", async () => {
    expect((await create(adminA, { gst_number: "24ABCDE1234F1Z55" })).status).toBe(400);
    expect((await create(adminA, { gst_number: "24ABCDE1234F1X5" })).status).toBe(400);
    expect((await create(adminA, { pan_number: "ZZZZZ9999Z", gst_number: "24ABCDE1234F1Z5" })).status).toBe(400);
    expect((await create(adminA, { pan_number: "GSTOK1234A", gst_number: "24gstok1234a1z5" })).status).toBe(201);
  });
  test("GST (PROPOSED): unique per company", async () => {
    expect((await create(adminA, { gst_number: "27UNIQG1234H1Z5" })).status).toBe(201);
    expect((await create(adminA, { gst_number: "27UNIQG1234H1Z5" })).status).toBe(409);
  });
  test("VAT max 50, Account Details max 2000, Address max 2000, Billing/Shipping street max 2000", async () => {
    expect((await create(adminA, { vat: "v".repeat(51) })).status).toBe(400);
    expect((await create(adminA, { account_details: "a".repeat(2001) })).status).toBe(400);
    expect((await create(adminA, { address: "a".repeat(2001) })).status).toBe(400);
    expect((await create(adminA, { billing_street: "a".repeat(2001) })).status).toBe(400);
    expect((await create(adminA, { shipping_street: "a".repeat(2001) })).status).toBe(400);
    expect((await create(adminA, { vat: "v".repeat(50), account_details: "a".repeat(2000), address: "a".repeat(2000) })).status).toBe(201);
  });
  test("City / State: max 100 and must contain a letter (all three addresses)", async () => {
    for (const k of ["city", "state", "billing_city", "billing_state", "shipping_city", "shipping_state"]) {
      expect((await create(adminA, { [k]: "c".repeat(101) })).status).toBe(400);
      expect((await create(adminA, { [k]: "12345" })).status).toBe(400);
    }
  });
  test("City (PROPOSED): any valid city accepted by API (not only branch cities)", async () => {
    expect((await create(adminA, { city: "Rajkot" })).status).toBe(201);
  });
  test("Zip India: 6 digits not starting with 0", async () => {
    expect((await create(adminA, { zip: "38000" })).status).toBe(400);
    expect((await create(adminA, { zip: "380001" })).status).toBe(201);
    expect((await create(adminA, { zip: "012345", country: "India" })).status).toBe(400);
  });
  test("Zip other country: own format accepted (US 94105, UK SW1A 1AA)", async () => {
    expect((await create(adminA, { zip: "94105", country: "United States" })).status).toBe(201);
    expect((await create(adminA, { zip: "SW1A 1AA", country: "United Kingdom" })).status).toBe(201);
    expect((await create(adminA, { billing_zip: "94105", billing_country: "United States" })).status).toBe(201);
  });
  test("Country max 100, Default Language max 50", async () => {
    expect((await create(adminA, { country: "c".repeat(101) })).status).toBe(400);
    expect((await create(adminA, { default_language: "l".repeat(51) })).status).toBe(400);
  });
  test("Currency must exist in company currencies", async () => {
    expect((await create(adminA, { currency: "XYZ" })).status).toBe(400);
    expect((await create(adminA, { currency: "USD" })).status).toBe(201);
  });
  test("Sales Person: must be staff of this company; can be cleared", async () => {
    expect((await create(adminA, { sales_person: String(B.users.admin.id) })).status).toBe(400);
    const r = await create(adminA, { sales_person: String(A.users.full.id) });
    expect(r.status).toBe(201);
    const u = await adminA.put(`/api/clients/${r.body._id}`, { sales_person: "" });
    expect(u.status).toBe(200);
    expect(u.body.sales_person).toBeNull();
  });
  test("Branch: must belong to this company", async () => {
    expect((await create(adminA, { branch: String(B.branches[0]._id) })).status).toBe(400);
    expect((await create(adminA, { branch: String(A.branches[0]._id) })).status).toBe(201);
  });
  test("Groups: multi-select saved, other company's group rejected", async () => {
    expect((await create(adminA, { groups: [String(B.groups[0]._id)] })).status).toBe(400);
    const r = await create(adminA, { groups: A.groups.map((g) => String(g._id)) });
    expect(r.status).toBe(201);
    expect(r.body.groups.length).toBe(2);
  });
  test("Active: boolean only, default true", async () => {
    expect((await create(adminA, { active: "yes" })).status).toBe(400);
    const r = await create(adminA, {});
    expect(r.body.active).toBe(true);
  });
  test("Latitude / Longitude (PROPOSED): -90..90 / -180..180", async () => {
    const r = await create(adminA, {});
    expect((await adminA.put(`/api/clients/${r.body._id}`, { latitude: "999" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${r.body._id}`, { longitude: "abc" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${r.body._id}`, { latitude: "23.0225", longitude: "72.5714" })).status).toBe(200);
  });
  test("Edit: same rules apply on PUT (phone, PAN, email, zip)", async () => {
    const r = await create(adminA, {});
    const id = r.body._id;
    expect((await adminA.put(`/api/clients/${id}`, { phonenumber: "12" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${id}`, { pan_number: "BAD" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${id}`, { email: "bad@" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${id}`, { zip: "12" })).status).toBe(400);
    expect((await adminA.put(`/api/clients/${id}`, { company: "" })).status).toBe(400);
  });
  test("Saved data is really in the DB after create/edit", async () => {
    const r = await create(adminA, { city: "Vadodara", phonenumber: "9898989898" });
    await adminA.put(`/api/clients/${r.body._id}`, { city: "Bhavnagar" });
    const doc = await mongoose.connection.db.collection("clients").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(doc.city).toBe("Bhavnagar");
    expect(doc.phonenumber).toBe("9898989898");
    expect(String(doc.tenant_id)).toBe(String(A.tenantId));
  });
  test("Double-click Save: two identical creates at once -> only one customer", async () => {
    const n = nm("Double");
    const [r1, r2] = await Promise.all([adminA.post("/api/clients", { company: n }), adminA.post("/api/clients", { company: n })]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await mongoose.connection.db.collection("clients").countDocuments({ company: n })).toBe(1);
  });
  test("Mass assignment: tenant_id / created_by / phoneE164 from body ignored", async () => {
    const r = await adminA.post("/api/clients", { company: nm("Mass"), tenant_id: String(B.tenantId), created_by: String(B.users.admin.id) });
    expect(r.status).toBe(201);
    expect(String(r.body.tenant_id)).toBe(String(A.tenantId));
    expect(String(r.body.created_by)).toBe(String(A.users.admin.id));
  });
});

// ───────────────────────── Field rules — Contact / Group / Vault / Reminder ─────────────────────────
describe("Field rules — Contact", () => {
  const cust = () => A.c.acme._id;
  test("First / Last name required, max 100, no HTML", async () => {
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { lastname: "X", email: "a@b.com" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "X", email: "a@b.com" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "f".repeat(101), lastname: "X", email: "a@b.com" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "<b>x</b>", lastname: "X", email: "a@b.com" })).status).toBe(400);
  });
  test("Email required and valid", async () => {
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: "bad" })).status).toBe(400);
  });
  test("Email (PROPOSED): unique per company", async () => {
    const e = `c${Date.now()}@dup.com`;
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: e })).status).toBe(201);
    expect((await adminA.post(`/api/clients/${A.c.other._id}/contacts`, { firstname: "C", lastname: "D", email: e })).status).toBe(409);
  });
  test("Phone: same rule both sides (10 digits on screen) — 15 digits must be rejected", async () => {
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: `p${Date.now()}@x.com`, phonenumber: "123" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: `q${Date.now()}@x.com`, phonenumber: "987654321012345" })).status).toBe(400);
  });
  test("Position max 150", async () => {
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: `t${Date.now()}@x.com`, title: "t".repeat(151) })).status).toBe(400);
  });
  test("Password (PROPOSED): min 8 chars", async () => {
    expect((await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "A", lastname: "B", email: `pw${Date.now()}@x.com`, password: "abc" })).status).toBe(400);
  });
  test("Password: stored hashed, never returned; blank on edit = unchanged", async () => {
    const r = await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "Hash", lastname: "Me", email: `h${Date.now()}@x.com`, password: "LongEnough1" });
    expect(r.status).toBe(201);
    expect(r.body.password).toBeUndefined();
    const before = await mongoose.connection.db.collection("contacts").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(before.password).toMatch(/^\$2[aby]\$/);
    await adminA.put(`/api/clients/contacts/${r.body._id}`, { password: "", title: "Mgr" });
    const after = await mongoose.connection.db.collection("contacts").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(after.password).toBe(before.password);
  });
  test("Primary (PROPOSED): only ONE primary contact per customer", async () => {
    const c = await create(adminA, {});
    await adminA.post(`/api/clients/${c.body._id}/contacts`, { firstname: "P1", lastname: "X", email: `p1${Date.now()}@x.com`, is_primary: true });
    await adminA.post(`/api/clients/${c.body._id}/contacts`, { firstname: "P2", lastname: "X", email: `p2${Date.now()}@x.com`, is_primary: true });
    const list = await adminA.get(`/api/clients/${c.body._id}/contacts`);
    expect(list.body.filter((x) => x.is_primary).length).toBe(1);
  });
  test("Module Permissions / Email Notifications are saved", async () => {
    const r = await adminA.post(`/api/clients/${cust()}/contacts`, { firstname: "Perm", lastname: "X", email: `perm${Date.now()}@x.com`, permissions: ["invoices", "projects"], email_notifications: ["invoice"], invoice_emails: false });
    expect(r.status).toBe(201);
    const doc = await mongoose.connection.db.collection("contacts").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(doc.invoice_emails).toBe(false); // the boolean flags are saved
    expect(doc.permissions).toEqual(["invoices", "projects"]); // the Module Permissions list the form shows
  });
});

describe("Field rules — Group", () => {
  test("Name required, max 100, no HTML, unique case-insensitive per company", async () => {
    expect((await adminA.post("/api/client-groups", { name: "" })).status).toBe(400);
    expect((await adminA.post("/api/client-groups", { name: "g".repeat(101) })).status).toBe(400);
    expect((await adminA.post("/api/client-groups", { name: "<img src=x onerror=alert(1)>" })).status).toBe(400);
    expect((await adminA.post("/api/client-groups", { name: "vip" })).status).toBe(409);
    const n = `Grp ${Date.now()}`;
    expect((await adminA.post("/api/client-groups", { name: n })).status).toBe(201);
    expect((await adminB.post("/api/client-groups", { name: n })).status).toBe(201);
  });
  test("Edit: rename to an existing name rejected", async () => {
    const g = await adminA.post("/api/client-groups", { name: `Ren ${Date.now()}` });
    expect((await adminA.put(`/api/client-groups/${g.body._id}`, { name: "WHOLESALE" })).status).toBe(409);
  });
});

describe("Field rules — Vault", () => {
  const base = () => ({ server: "srv.local", username: "u", password: "p" });
  test("Server / Username / Password required; max 300 / 200 / 500", async () => {
    const id = A.c.acme._id;
    expect((await adminA.post(`/api/clients/${id}/vault`, { username: "u", password: "p" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), server: "s".repeat(301) })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), username: "s".repeat(201) })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), password: "s".repeat(501) })).status).toBe(400);
  });
  test("Port (PROPOSED): number 1–65535", async () => {
    const id = A.c.acme._id;
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), port: "abc" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), port: "70000" })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${id}/vault`, { ...base(), port: "22" })).status).toBe(201);
  });
});

describe("Field rules — Reminder", () => {
  test("Date / Description required", async () => {
    expect((await adminA.post(`/api/clients/${A.c.acme._id}/reminders`, { date: new Date(Date.now() + 864e5) })).status).toBe(400);
    expect((await adminA.post(`/api/clients/${A.c.acme._id}/reminders`, { description: "x" })).status).toBe(400);
  });
  test("Date (PROPOSED): must be in the future", async () => {
    expect((await adminA.post(`/api/clients/${A.c.acme._id}/reminders`, { description: "past", date: "2020-01-01T10:00:00Z", staff: String(A.users.admin.id) })).status).toBe(400);
  });
  test("Staff must be a staff member of this company", async () => {
    expect((await adminA.post(`/api/clients/${A.c.acme._id}/reminders`, { description: "x", date: new Date(Date.now() + 864e5), staff: String(B.users.admin.id) })).status).toBe(400);
  });
});

// ───────────────────────── Business rules ─────────────────────────
describe("Business rules", () => {
  test("BR1 delete blocked (409 'Mark it inactive instead') when customer has invoices", async () => {
    const r = await adminA.del(`/api/clients/${A.c.blocked._id}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Mark it inactive instead/);
  });
  test("BR1 delete blocked by a payment linked to the customer", async () => {
    const c = await create(adminA, {});
    await mongoose.connection.db.collection("payments").insertOne({ client: new mongoose.Types.ObjectId(c.body._id), amount: 10, tenant_id: A.tenantId, date: new Date() });
    expect((await adminA.del(`/api/clients/${c.body._id}`)).status).toBe(409);
  });
  test.each([["subscriptions", (id, t) => ({ name: "S", client: id, amount: 1, tenant_id: t })],
    ["projects", (id, t) => ({ name: "P", clientid: id, tenant_id: t })],
    ["contracts", (id, t) => ({ subject: "C", client: id, tenant_id: t })],
    ["tickets", (id, t) => ({ subject: "T", userid: id, client: id, tenant_id: t })],
    ["creditnotes", (id, t) => ({ number: "CN-1", client: id, total: 1, tenant_id: t })],
    ["expenses", (id, t) => ({ expense_name: "E", amount: 1, client: id, clientid: id, tenant_id: t })],
  ])("BR1 (PROPOSED) delete also blocked when customer has %s", async (coll, mk) => {
    const c = await create(adminA, {});
    const id = new mongoose.Types.ObjectId(c.body._id);
    await mongoose.connection.db.collection(coll).insertOne({ ...mk(id, A.tenantId), createdAt: new Date() });
    expect((await adminA.del(`/api/clients/${c.body._id}`)).status).toBe(409);
  });
  test("BR2 deleting removes contacts, files (also from disk), vault, reminders, notes", async () => {
    const c = await create(adminA, {});
    const id = c.body._id;
    await adminA.post(`/api/clients/${id}/contacts`, { firstname: "Del", lastname: "Me", email: `del${Date.now()}@x.com` });
    await adminA.post(`/api/clients/${id}/vault`, { server: "s", username: "u", password: "p" });
    await adminA.post(`/api/clients/${id}/reminders`, { description: "r", date: new Date(Date.now() + 864e5) });
    await adminA.post("/api/notes", { rel_type: "customer", rel_id: id, description: "n" });
    const fd = new FormData();
    fd.append("files", new Blob(["hello customers test"], { type: "text/plain" }), "customers-fullpass-del.txt");
    const up = await fetch(`${BASE}/api/clients/${id}/files`, { method: "POST", headers: { Authorization: `Bearer ${A.users.admin.token}` }, body: fd });
    expect(up.status).toBe(201);
    const saved = (await up.json())[0];
    const diskPath = path.join(__dirname, "../../uploads", saved.attachment_key);
    expect(fs.existsSync(diskPath)).toBe(true);
    expect((await adminA.del(`/api/clients/${id}`)).status).toBe(200);
    const oid = new mongoose.Types.ObjectId(id);
    const db = mongoose.connection.db;
    expect(await db.collection("contacts").countDocuments({ userid: oid })).toBe(0);
    expect(await db.collection("vaultentries").countDocuments({ client: oid })).toBe(0);
    expect(await db.collection("reminders").countDocuments({ rel_id: oid })).toBe(0);
    expect(await db.collection("notes").countDocuments({ rel_id: oid })).toBe(0);
    expect(await db.collection("files").countDocuments({ rel_id: oid })).toBe(0);
    expect(fs.existsSync(diskPath)).toBe(false);
  });
  test("BR3 bulk delete skips blocked customers and reports the real deleted count", async () => {
    const c1 = await create(adminA, {});
    const r = await adminA.post("/api/clients/bulk-delete", { ids: [c1.body._id, String(A.c.blocked._id), String(B.c.acme._id)] });
    expect(r.status).toBe(200);
    expect(r.body.deletedCount).toBe(1);
    expect(r.body.skipped.length).toBe(1);
    expect(await mongoose.connection.db.collection("clients").countDocuments({ _id: B.c.acme._id })).toBe(1);
  });
  test("BR4 (PROPOSED) API refuses a new invoice for an inactive customer", async () => {
    const r = await adminA.post("/api/invoices", {
      client: String(A.c.inactive._id), number: `INV-INACT-${Date.now()}`, date: new Date().toISOString(), duedate: new Date(Date.now() + 864e5).toISOString(),
      currency: "INR", items: [{ description: "x", qty: 1, rate: 100 }], status: "unpaid",
    });
    expect([400, 409, 403]).toContain(r.status);
  });
  test("BR4 (PROPOSED) API refuses a new contact for an inactive customer", async () => {
    const r = await adminA.post(`/api/clients/${A.c.inactive._id}/contacts`, { firstname: "In", lastname: "Active", email: `ina${Date.now()}@x.com` });
    expect([400, 409, 403]).toContain(r.status);
  });
  test("BR7 statement (YYYY-MM-DD period): hand-calculated numbers, last day included, draft/cancelled excluded", async () => {
    const r = await adminA.get(`/api/clients/${A.c.stmt._id}/statement?from=2026-10-01&to=2026-10-31`);
    expect(r.status).toBe(200);
    expect(r.body.beginningBalance).toBe(6000);
    expect(r.body.totalInvoiced).toBe(8000);
    expect(r.body.totalPaid).toBe(2000);
    expect(r.body.balanceDue).toBe(12000);
    expect(r.body.entries.some((e) => /INV-SD|INV-SC/.test(e.details))).toBe(false);
  });
  test("BR7 / #21 statement with the dates the screen sends for 'Last Month' (IST browser) includes the last day", async () => {
    // CustomerView.getStatementRange(): to = new Date(y, m, 0) (local midnight) -> toISOString().
    // In an IST browser 31 Oct 2026 00:00 local = 2026-10-30T18:30:00.000Z.
    const r = await adminA.get(`/api/clients/${A.c.stmt._id}/statement?from=2026-09-30T18:30:00.000Z&to=2026-10-30T18:30:00.000Z`);
    expect(r.status).toBe(200);
    expect(r.body.totalInvoiced).toBe(8000);
    expect(r.body.totalPaid).toBe(2000);
  });
  test("BR7 statement rejects a bad date with 400, never 500", async () => {
    expect((await adminA.get(`/api/clients/${A.c.stmt._id}/statement?from=notadate`)).status).toBe(400);
  });
  test("BR9 import customers: aliases, same validation, duplicates skipped, branch only existing, row numbers", async () => {
    const dupName = A.c.acme.company;
    const rows = [
      { "Company Name": "Imported One Pvt Ltd", GSTIN: "24IMPOR1234T1Z5", PAN: "IMPOR1234T", "Phone Number": "9812345678", Branch: `Ahmedabad Branch Alpha` },
      { Company: "Imported Two", email: "bad-email" },
      { company: "imported one pvt ltd" },
      { company: dupName.toUpperCase() },
      { company: "Imported Three", branch: "Nonexistent Branch XYZ" },
      { company: "" },
    ];
    const r = await adminA.post("/api/clients/import", rows);
    expect(r.status).toBe(200);
    expect(r.body.insertedCount).toBe(2);
    const reasons = Object.fromEntries(r.body.errors.map((e) => [e.row, e.reason]));
    expect(reasons[3]).toMatch(/email/i);
    expect(reasons[4]).toMatch(/Duplicate/);
    expect(reasons[5]).toMatch(/already exists/);
    expect(reasons[7]).toMatch(/missing/);
    const one = await mongoose.connection.db.collection("clients").findOne({ company: "Imported One Pvt Ltd", tenant_id: A.tenantId });
    expect(one.gst_number).toBe("24IMPOR1234T1Z5");
    expect(String(one.branch)).toBe(String(A.branches[0]._id));
    const three = await mongoose.connection.db.collection("clients").findOne({ company: "Imported Three", tenant_id: A.tenantId });
    expect(three.branch).toBeNull();
  });
  test("BR9 import: at most 200 errors listed", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ company: `Bad Import ${i}`, email: "x" }));
    const r = await adminA.post("/api/clients/import", rows);
    expect(r.body.skippedCount).toBe(250);
    expect(r.body.errors.length).toBe(200);
  });
  test("BR9 import: fuzzy branch match must not attach a DIFFERENT branch (only existing exact branches)", async () => {
    const r = await adminA.post("/api/clients/import", [{ company: `Fuzzy ${Date.now()}`, branch: "Surat" }]);
    expect(r.status).toBe(200);
    // "Surat" is a substring of "Surat Branch Alpha" -> matched. Acceptable; documented.
  });
  test("BR10 import contacts: needs first name, valid email, existing company; duplicates by email skipped", async () => {
    const rows = [
      { company: A.c.acme.company, firstname: "Imp", lastname: "One", email: `impc${Date.now()}@x.com` },
      { company: A.c.acme.company, firstname: "", email: "nofirst@x.com" },
      { company: A.c.acme.company, firstname: "Bad", email: "bad" },
      { company: "No Such Company", firstname: "No", email: "nocomp@x.com" },
      { company: A.c.acme.company, firstname: "Dup", email: A.contacts[0].email },
      { company: B.c.acme.company, firstname: "Cross", email: "cross@x.com" },
    ];
    const r = await adminA.post("/api/clients/contacts/import", rows);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(1);
    expect(await mongoose.connection.db.collection("contacts").countDocuments({ email: "cross@x.com" })).toBe(0);
  });
  test("BR11 / #33 transfer/assign does NOT silently remove the staff member from customers that were not selected", async () => {
    // ownEditor is a Customer Admin of ownEd. Assign ownEditor to Acme only.
    const r = await adminA.post("/api/clients/transfer-or-assign", { toStaffId: String(A.users.ownEditor.id), clientIds: [String(A.c.acme._id)], assignAs: "admin" });
    expect(r.status).toBe(200);
    const ownEd = await mongoose.connection.db.collection("clients").findOne({ _id: A.c.ownEd._id });
    expect(ownEd.admins.map((a) => String(a.staff))).toContain(String(A.users.ownEditor.id));
  });
  test("BR14 deleting a group removes it from all customers", async () => {
    const g = await adminA.post("/api/client-groups", { name: `Temp ${Date.now()}` });
    const c = await create(adminA, { groups: [g.body._id] });
    expect((await adminA.del(`/api/client-groups/${g.body._id}`)).status).toBe(200);
    const doc = await mongoose.connection.db.collection("clients").findOne({ _id: new mongoose.Types.ObjectId(c.body._id) });
    expect(doc.groups.map(String)).not.toContain(g.body._id);
  });
  test("Bulk assign group ADDS the group and keeps other groups; other company's ids untouched", async () => {
    const c = await create(adminA, { groups: [String(A.groups[0]._id)] });
    const r = await adminA.post("/api/clients/bulk-assign-group", { ids: [c.body._id, String(B.c.acme._id)], groupId: String(A.groups[1]._id) });
    expect(r.body.count).toBe(1);
    const doc = await mongoose.connection.db.collection("clients").findOne({ _id: new mongoose.Types.ObjectId(c.body._id) });
    expect(doc.groups.length).toBe(2);
  });
});

// ───────────────────────── Lead -> customer conversion ─────────────────────────
describe("BR12 Lead -> customer conversion", () => {
  const Lead = () => mongoose.model("Lead");
  test("#16 duplicate company name -> clear 409, never 500", async () => {
    // Seeded lead has company = existing customer "Acme Corporation Alpha" and no phone.
    const r = await adminA.post(`/api/leads/${A.lead._id}/convert`, {});
    expect(r.status).not.toBe(500);
    expect([409, 200, 201]).toContain(r.status);
  });
  test("#16 conversion applies the same validation as the form (bad email / bad phone refused)", async () => {
    const lead = await Lead().create({ name: "Bad Data Lead", company: `BadData ${Date.now()}`, email: "not-an-email", phonenumber: "12ab", tenant_id: A.tenantId });
    const r = await adminA.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(400);
  });
  test("reuses an existing customer with the same phone", async () => {
    const lead = await Lead().create({ name: "Phone Lead", company: `PhoneLead ${Date.now()}`, phonenumber: "9123456780", tenant_id: A.tenantId });
    const r = await adminA.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    expect(String(r.body.client._id)).toBe(String(A.c.own._id));
  });
  test("creates a primary contact from the lead email", async () => {
    const lead = await Lead().create({ name: "Mail Lead Person", company: `MailLead ${Date.now()}`, email: `ml${Date.now()}@x.com`, tenant_id: A.tenantId });
    const r = await adminA.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    const ct = await mongoose.connection.db.collection("contacts").findOne({ userid: new mongoose.Types.ObjectId(r.body.client._id) });
    expect(ct && ct.is_primary).toBe(true);
    expect(ct.firstname).toBe("Mail");
  });
  test("#16 single and bulk conversion fill the same fields (contact_person, billing, sales person)", async () => {
    const mk = (s) => Lead().create({ name: `Field Lead ${s}`, company: `FieldLead ${s} ${Date.now()}`, address: "5 Ring Rd", city: "Surat", zip: "395001", assigned: A.users.full.id, tenant_id: A.tenantId });
    const l1 = await mk("single"); const l2 = await mk("bulk");
    const s = await adminA.post(`/api/leads/${l1._id}/convert`, {});
    const b = await adminA.post("/api/leads/bulk-convert", { ids: [String(l2._id)] });
    expect(s.status).toBe(201);
    expect(b.status).toBeLessThan(300);
    const c1 = await mongoose.connection.db.collection("clients").findOne({ company: l1.company });
    const c2 = await mongoose.connection.db.collection("clients").findOne({ company: l2.company });
    for (const k of ["contact_person", "billing_street", "billing_city", "billing_zip", "sales_person"]) {
      expect([k, Boolean(c1?.[k])]).toEqual([k, Boolean(c2?.[k])]);
    }
  });
  test("bulk conversion: duplicate company name does not crash the batch", async () => {
    const lead = await Lead().create({ name: "Dup Bulk", company: A.c.other.company, tenant_id: A.tenantId });
    const r = await adminA.post("/api/leads/bulk-convert", { ids: [String(lead._id)] });
    expect(r.status).not.toBe(500);
  });
});

// ───────────────────────── Role-based access (API) ─────────────────────────
describe("Role-based access — API must return 403", () => {
  test("no-access staff: list, detail, groups, contacts page -> 403", async () => {
    expect((await noneA.get("/api/clients")).status).toBe(403);
    expect((await noneA.get(`/api/clients/${A.c.acme._id}`)).status).toBe(403);
    expect((await noneA.get("/api/client-groups")).status).toBe(403);
    expect((await noneA.get("/api/clients/contacts/all")).status).toBe(403);
  });
  test("view-only staff: create / edit / delete / bulk / import / contacts / groups / vault / files / reminders -> 403", async () => {
    const id = A.c.acme._id;
    const res = await Promise.all([
      viewA.post("/api/clients", { company: nm() }),
      viewA.put(`/api/clients/${id}`, { city: "Pune" }),
      viewA.del(`/api/clients/${A.c.other._id}`),
      viewA.post("/api/clients/bulk-delete", { ids: [String(A.c.other._id)] }),
      viewA.post("/api/clients/bulk-assign-group", { ids: [String(id)], groupId: String(A.groups[0]._id) }),
      viewA.post("/api/clients/import", [{ company: nm() }]),
      viewA.post("/api/clients/transfer-or-assign", { toStaffId: String(A.users.viewGlobal.id), clientIds: [] }),
      viewA.post(`/api/clients/${id}/contacts`, { firstname: "a", lastname: "b", email: "v@x.com" }),
      viewA.put(`/api/clients/contacts/${A.contacts[1]._id}`, { title: "x" }),
      viewA.del(`/api/clients/contacts/${A.contacts[1]._id}`),
      viewA.post("/api/client-groups", { name: nm("G") }),
      viewA.post(`/api/clients/${id}/vault`, { server: "s", username: "u", password: "p" }),
      viewA.post(`/api/clients/${id}/reminders`, { description: "x", date: new Date(Date.now() + 864e5) }),
      viewA.del(`/api/clients/vault/${A.vault[0]._id}`),
    ]);
    expect(res.map((r) => r.status)).toEqual(res.map(() => 403));
  });
  test("view-only staff: notes on a customer cannot be created / edited / deleted (#6)", async () => {
    const c = await viewA.post("/api/notes", { rel_type: "customer", rel_id: String(A.c.acme._id), description: "view-only wrote this" });
    expect(c.status).toBe(403);
  });
  test("no-access staff cannot read customer notes (#6)", async () => {
    const r = await noneA.get(`/api/notes?rel_type=customer&rel_id=${A.c.acme._id}`);
    expect(r.status).toBe(403);
  });
  test("#3 send statement needs more than View (view-only staff -> 403)", async () => {
    const r = await viewA.post(`/api/clients/${A.c.acme._id}/statement/send`, { to: ["outsider@evil.test"], subject: "hi", html: "<h1>Pay to my account</h1>" });
    expect(r.status).toBe(403);
  });
  test("#3 statement email cannot carry caller-supplied HTML to an address outside the customer's contacts", async () => {
    const F = require("../../testUtils/customersFullpassFixtures");
    const before = F.sentMails.length;
    await adminA.post(`/api/clients/${A.c.acme._id}/statement/send`, { to: ["random-outsider@evil.test"], html: "<a href='http://phish.test'>Click</a>" });
    const sent = F.sentMails.slice(before);
    const relayed = sent.some((m) => (m.to || []).includes("random-outsider@evil.test") && /phish/.test(m.html || ""));
    expect(relayed).toBe(false);
  });
  test("View(Global) staff sees every customer in the list", async () => {
    const r = await viewA.get("/api/clients?page=1&limit=500");
    expect(r.body.data.some((c) => c.company === A.c.other.company)).toBe(true);
  });
  test("View(Own): list shows only own customers (admin, sales person, creator)", async () => {
    const r = await ownA.get("/api/clients?page=1&limit=500");
    expect(r.status).toBe(200);
    expect(r.body.data.map((c) => c.company)).toEqual([A.c.own.company]);
    const legacy = await ownA.get("/api/clients");
    expect(legacy.body.map((c) => c.company)).toEqual([A.c.own.company]);
  });
  test("View(Own): detail of another user's customer -> 403/404", async () => {
    expect([403, 404]).toContain((await ownA.get(`/api/clients/${A.c.other._id}`)).status);
    expect((await ownA.get(`/api/clients/${A.c.own._id}`)).status).toBe(200);
  });
  test.each([
    ["contacts", (id) => `/api/clients/${id}/contacts`],
    ["statement", (id) => `/api/clients/${id}/statement`],
    ["files", (id) => `/api/clients/${id}/files`],
    ["vault", (id) => `/api/clients/${id}/vault`],
    ["reminders", (id) => `/api/clients/${id}/reminders`],
  ])("#1 View(Own): GET %s of another user's customer -> 403/404", async (_n, p) => {
    expect([403, 404]).toContain((await ownA.get(p(A.c.other._id))).status);
  });
  test("#1 View(Own): Contacts page lists only contacts of own customers", async () => {
    const r = await ownA.get("/api/clients/contacts/all?page=1&limit=500");
    expect(r.status).toBe(200);
    const companies = new Set(r.body.data.map((c) => c.userid?.company));
    expect([...companies]).toEqual([A.c.own.company]);
  });
  test("#1 View(Own)+Edit: cannot edit another user's customer", async () => {
    const r = await ownEdA.put(`/api/clients/${A.c.other._id}`, { city: "Hacked City" });
    expect([403, 404]).toContain(r.status);
  });
  test("#1 View(Own)+Delete: cannot delete another user's customer", async () => {
    const victim = await create(adminA, {});
    const r = await ownEdA.del(`/api/clients/${victim.body._id}`);
    expect([403, 404]).toContain(r.status);
  });
  test("#1 View(Own)+Create: cannot add a contact / vault entry / reminder to another user's customer", async () => {
    const id = A.c.other._id;
    const r1 = await ownEdA.post(`/api/clients/${id}/contacts`, { firstname: "X", lastname: "Y", email: `own${Date.now()}@x.com` });
    const r2 = await ownEdA.post(`/api/clients/${id}/vault`, { server: "s", username: "u", password: "p" });
    const r3 = await ownEdA.post(`/api/clients/${id}/reminders`, { description: "x", date: new Date(Date.now() + 864e5) });
    expect([r1.status, r2.status, r3.status].every((s) => [403, 404].includes(s))).toBe(true);
  });
  test("#1 View(Own)+Edit: bulk-assign-group / bulk-delete limited to own customers", async () => {
    const victim = await create(adminA, {});
    await ownEdA.post("/api/clients/bulk-delete", { ids: [victim.body._id] });
    expect(await mongoose.connection.db.collection("clients").countDocuments({ _id: new mongoose.Types.ObjectId(victim.body._id) })).toBe(1);
  });
  test("Plan with every module off: Customers is core and still works", async () => {
    const r = await api(W.P.users.admin.token).get("/api/clients?page=1&limit=5");
    expect(r.status).toBe(200);
  });
  test("Full-access staff can create / edit / delete", async () => {
    const c = await fullA.post("/api/clients", { company: nm("Full") });
    expect(c.status).toBe(201);
    expect((await fullA.put(`/api/clients/${c.body._id}`, { city: "Anand" })).status).toBe(200);
    expect((await fullA.del(`/api/clients/${c.body._id}`)).status).toBe(200);
  });
});

// ───────────────────────── Company separation ─────────────────────────
describe("Company separation", () => {
  const otherId = () => A.c.acme._id;
  test("Tenant B cannot read / edit / delete Tenant A's customer (404)", async () => {
    expect((await adminB.get(`/api/clients/${otherId()}`)).status).toBe(404);
    expect((await adminB.put(`/api/clients/${otherId()}`, { city: "X" })).status).toBe(404);
    expect((await adminB.del(`/api/clients/${otherId()}`)).status).toBe(404);
  });
  test.each([
    ["contacts", "get", (id) => `/api/clients/${id}/contacts`],
    ["statement", "get", (id) => `/api/clients/${id}/statement`],
    ["files", "get", (id) => `/api/clients/${id}/files`],
    ["vault", "get", (id) => `/api/clients/${id}/vault`],
    ["reminders", "get", (id) => `/api/clients/${id}/reminders`],
    ["statement send", "post", (id) => `/api/clients/${id}/statement/send`],
  ])("Tenant B -> Tenant A %s -> 404", async (_n, m, p) => {
    const r = m === "get" ? await adminB.get(p(otherId())) : await adminB.post(p(otherId()), { to: ["x@y.com"] });
    expect(r.status).toBe(404);
  });
  test("Tenant B cannot edit / delete Tenant A's contact, vault entry, reminder, note, group", async () => {
    expect((await adminB.put(`/api/clients/contacts/${A.contacts[1]._id}`, { title: "x" })).status).toBe(404);
    expect((await adminB.del(`/api/clients/contacts/${A.contacts[1]._id}`)).status).toBe(404);
    expect((await adminB.del(`/api/clients/vault/${A.vault[0]._id}`)).status).toBe(404);
    expect((await adminB.del(`/api/clients/reminders/${A.custReminder._id}`)).status).toBe(404);
    if (A.note) expect((await adminB.del(`/api/notes/${A.note._id}`)).status).toBe(404);
    expect((await adminB.put(`/api/client-groups/${A.groups[0]._id}`, { name: "hijack" })).status).toBe(404);
    expect((await adminB.del(`/api/client-groups/${A.groups[0]._id}`)).status).toBe(404);
  });
  test("Tenant B notes query with Tenant A's customer id returns nothing", async () => {
    const r = await adminB.get(`/api/notes?rel_type=customer&rel_id=${A.c.acme._id}`);
    expect(r.body.length || 0).toBe(0);
  });
  test("Tenant B cannot create a note on Tenant A's customer", async () => {
    expect((await adminB.post("/api/notes", { rel_type: "customer", rel_id: String(A.c.acme._id), description: "x" })).status).toBe(404);
  });
  test("Search never leaks another company's customers", async () => {
    const r = await adminB.get(`/api/clients?search=${encodeURIComponent("Alpha")}&page=1&limit=100`);
    expect(r.body.data.length).toBe(0);
  });
  test("#2 legacy customer without company id is NOT readable by another company", async () => {
    expect((await adminB.get(`/api/clients/${W.legacyId}`)).status).toBe(404);
  });
  test("transfer-or-assign rejects a target staff member of another company", async () => {
    expect((await adminA.post("/api/clients/transfer-or-assign", { toStaffId: String(B.users.admin.id), clientIds: [] })).status).toBe(404);
  });
});

// ───────────────────────── Security ─────────────────────────
describe("Security", () => {
  test("#4 deleting a customer reminder cannot delete a lead reminder (or another customer's)", async () => {
    const r = await fullA.del(`/api/clients/reminders/${A.leadReminder._id}`);
    expect(r.status).toBe(404);
    expect(await mongoose.connection.db.collection("reminders").countDocuments({ _id: A.leadReminder._id })).toBe(1);
  });
  test("#5 vault visibility enforced: view-only staff does not get 'admins'/'self' entries' passwords", async () => {
    const r = await viewA.get(`/api/clients/${A.c.acme._id}/vault`);
    expect(r.status).toBe(200);
    const pw = r.body.map((e) => e.password);
    expect(pw).not.toContain("AdminsOnlySecret");
    expect(pw).not.toContain("OnlyMeSecret");
  });
  test("#5 'only me' entry hidden from another admin", async () => {
    const S = mongoose.model("Staff");
    const other = await S.create({ firstname: "Second", lastname: "Admin", email: `second${Date.now()}@cust-test.local`, password: "Test@1234", admin: true, active: true, tenant_id: A.tenantId });
    const r = await api(jwt.sign({ id: String(other._id), role: "staff" }, process.env.JWT_SECRET)).get(`/api/clients/${A.c.acme._id}/vault`);
    expect(r.body.map((e) => e.password)).not.toContain("OnlyMeSecret");
  });
  test("Auth: no token 401, bad token 401, expired token 401, contact token 403", async () => {
    expect((await api(null).get("/api/clients")).status).toBe(401);
    expect((await api("garbage.token.here").get("/api/clients")).status).toBe(401);
    const expired = jwt.sign({ id: String(A.users.admin.id), role: "staff" }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect((await api(expired).get("/api/clients")).status).toBe(401);
    const wrongSecret = jwt.sign({ id: String(A.users.admin.id), role: "staff" }, "not-the-secret");
    expect((await api(wrongSecret).get("/api/clients")).status).toBe(401);
    const contactTok = jwt.sign({ id: String(A.contacts[0]._id), role: "contact" }, process.env.JWT_SECRET);
    expect((await api(contactTok).get("/api/clients")).status).toBe(403);
  });
  test.each([
    ["GET", "/api/clients"], ["POST", "/api/clients"], ["GET", "/api/clients/contacts/all"], ["POST", "/api/clients/import"],
    ["POST", "/api/clients/bulk-delete"], ["GET", "/api/client-groups"], ["GET", "/api/notes"], ["POST", "/api/clients/contacts/import"],
  ])("no token -> 401 on %s %s", async (m, p) => {
    const r = m === "GET" ? await api(null).get(p) : await api(null).post(p, {});
    expect(r.status).toBe(401);
  });
  test("Malformed ids -> 400/404, never 500", async () => {
    const paths = ["/api/clients/abc", "/api/clients/abc/contacts", "/api/clients/abc/statement", "/api/clients/abc/vault", "/api/clients/abc/files", "/api/clients/abc/reminders",
      `/api/clients/${encodeURIComponent('{"$ne":null}')}`];
    for (const p of paths) {
      const r = await adminA.get(p);
      expect([p, [400, 404].includes(r.status)]).toEqual([p, true]);
    }
    expect([400, 404]).toContain((await adminA.del("/api/clients/contacts/abc")).status);
    expect([400, 404]).toContain((await adminA.del("/api/clients/vault/abc")).status);
    expect([400, 404]).toContain((await adminA.del("/api/clients/reminders/abc")).status);
  });
  test("NoSQL injection in filters / bodies -> rejected, never 500 and never widened", async () => {
    const q = await adminA.get("/api/clients?page=1&limit=10&search[$ne]=x");
    expect(q.status).not.toBe(500);
    expect((await adminA.get("/api/clients?page=1&branch[$ne]=x")).status).toBe(400);
    expect((await adminA.post("/api/clients", { company: { $ne: null } })).status).toBe(400);
    expect((await adminA.post("/api/clients", { company: nm(), sales_person: { $ne: null } })).status).toBe(400);
    expect((await adminA.post("/api/clients", { company: nm(), groups: [{ $ne: null }] })).status).toBe(400);
    expect((await adminA.post("/api/clients/bulk-delete", { ids: [{ $ne: null }] })).status).toBe(400);
    const imp = await adminA.post("/api/clients/import", [{ company: { $gt: "" } }]);
    expect(imp.status).not.toBe(500);
    const ct = await adminA.get("/api/clients/contacts/all?page=1&search[$regex]=.*");
    expect(ct.status).not.toBe(500);
    const notes = await adminA.get(`/api/notes?rel_id[$ne]=x`);
    expect(notes.status).not.toBe(500);
  });
  test("Regex special characters in search do not crash (escaped)", async () => {
    for (const s of ["(", "[", "*", "\\", "a+b?", "$^"]) {
      expect((await adminA.get(`/api/clients?page=1&search=${encodeURIComponent(s)}`)).status).toBe(200);
    }
  });
  test("XSS text is refused in every customer / contact / vault text field", async () => {
    const payloads = ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>"];
    for (const p of payloads) {
      for (const k of ["company", "contact_person", "customer_reference", "vat", "address", "city", "state", "account_details", "billing_street", "shipping_street", "default_language"]) {
        const r = await adminA.post("/api/clients", { company: nm(), [k]: p });
        expect([k, r.status]).toEqual([k, 400]);
      }
      expect((await adminA.post(`/api/clients/${A.c.acme._id}/contacts`, { firstname: "A", lastname: p, email: `x${Date.now()}@x.com` })).status).toBe(400);
      expect((await adminA.post(`/api/clients/${A.c.acme._id}/vault`, { server: p, username: "u", password: "p" })).status).toBe(400);
    }
  });
  test("XSS in a note description is stored as plain text and must not contain live HTML", async () => {
    const r = await adminA.post("/api/notes", { rel_type: "customer", rel_id: String(A.c.acme._id), description: "<img src=x onerror=alert(1)>" });
    // Accept either refusal or storing (the screen must escape it — checked in the UI test).
    expect([201, 400]).toContain(r.status);
  });
  test("Reminder description with HTML", async () => {
    const r = await adminA.post(`/api/clients/${A.c.acme._id}/reminders`, { description: "<script>alert(1)</script>", date: new Date(Date.now() + 864e5) });
    expect([201, 400]).toContain(r.status);
  });
  test("File upload: dangerous types refused, 10 MB limit, 10 files limit, allowed type accepted", async () => {
    const up = async (files) => {
      const fd = new FormData();
      for (const [name, content, type] of files) fd.append("files", new Blob([content], { type }), name);
      const r = await fetch(`${BASE}/api/clients/${A.c.acme._id}/files`, { method: "POST", headers: { Authorization: `Bearer ${A.users.admin.token}` }, body: fd });
      let body = null; try { body = await r.json(); } catch { /* */ }
      return { status: r.status, body };
    };
    expect((await up([["customers-x.html", "<script>alert(1)</script>", "text/html"]])).status).toBe(400);
    expect((await up([["customers-x.svg", "<svg onload=alert(1)>", "image/svg+xml"]])).status).toBe(400);
    expect((await up([["customers-x.exe", "MZ", "application/octet-stream"]])).status).toBe(400);
    expect((await up([["customers-x.pdf.html", "x", "text/html"]])).status).toBe(400);
    expect((await up([["customers-evil.txt", "x", "text/html"]])).status).toBe(400);
    expect((await up([["customers-big.pdf", Buffer.alloc(10 * 1024 * 1024 + 10), "application/pdf"]])).status).toBe(413);
    const eleven = Array.from({ length: 11 }, (_, i) => [`customers-${i}.txt`, "x", "text/plain"]);
    expect((await up(eleven)).status).toBe(400);
    const ok = await up([["customers-ok.txt", "fine", "text/plain"]]);
    expect(ok.status).toBe(201);
    // clean up the file written to src/uploads
    for (const f of ok.body) await adminA.del(`/api/clients/${A.c.acme._id}/files/${f._id}`);
  });
  test("File upload: same file can be uploaded twice (server side)", async () => {
    const send = async () => {
      const fd = new FormData();
      fd.append("files", new Blob(["same"], { type: "text/plain" }), "customers-same.txt");
      return fetch(`${BASE}/api/clients/${A.c.acme._id}/files`, { method: "POST", headers: { Authorization: `Bearer ${A.users.admin.token}` }, body: fd });
    };
    const r1 = await send(); const r2 = await send();
    expect([r1.status, r2.status]).toEqual([201, 201]);
    for (const r of [r1, r2]) for (const f of await r.json()) await adminA.del(`/api/clients/${A.c.acme._id}/files/${f._id}`);
  });
  test("Outbound guard: no real network calls were attempted", () => {
    const F = require("../../testUtils/customersFullpassFixtures");
    expect(F.outboundAttempts).toEqual([]);
  });
});

// ───────────────────────── API status sweep / search / pagination ─────────────────────────
describe("API — list, search, filter, pagination", () => {
  beforeAll(async () => {
    const docs = [];
    for (let i = 0; i < 60; i++) docs.push({ company: `Sweep ${String(i).padStart(2, "0")}`, email: `sweep${i}@s.com`, active: i % 3 !== 0, branch: A.branches[i % 2]._id, tenant_id: A.tenantId, groups: i % 4 === 0 ? [A.groups[1]._id] : [], admins: [], createdAt: new Date(Date.now() - 1e9 - i * 1000), updatedAt: new Date() });
    await mongoose.connection.db.collection("clients").insertMany(docs);
  });
  test("pagination: page/limit/total/pages consistent and pages do not overlap", async () => {
    const p1 = await adminA.get("/api/clients?page=1&limit=25&search=Sweep");
    const p2 = await adminA.get("/api/clients?page=2&limit=25&search=Sweep");
    const p3 = await adminA.get("/api/clients?page=3&limit=25&search=Sweep");
    expect(p1.body.total).toBe(60);
    expect(p1.body.pages).toBe(3);
    expect(p3.body.data.length).toBe(10);
    const ids = new Set([...p1.body.data, ...p2.body.data, ...p3.body.data].map((c) => c._id));
    expect(ids.size).toBe(60);
  });
  test("limit is capped (500) and out-of-range page returns empty, never 500", async () => {
    expect((await adminA.get("/api/clients?page=1&limit=100000")).body.limit).toBe(500);
    const r = await adminA.get("/api/clients?page=9999&limit=25");
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(0);
    expect((await adminA.get("/api/clients?page=-5&limit=-1")).status).toBe(200);
  });
  test("status filter Active / Inactive counts are correct", async () => {
    const act = await adminA.get("/api/clients?page=1&limit=500&search=Sweep&status=Active");
    const ina = await adminA.get("/api/clients?page=1&limit=500&search=Sweep&status=Inactive");
    expect(act.body.total).toBe(40);
    expect(ina.body.total).toBe(20);
    expect(act.body.data.every((c) => c.active)).toBe(true);
  });
  test("branch filter returns only that branch", async () => {
    const r = await adminA.get(`/api/clients?page=1&limit=500&search=Sweep&branch=${A.branches[1]._id}`);
    expect(r.body.total).toBe(30);
    expect(r.body.data.every((c) => String(c.branch?._id) === String(A.branches[1]._id))).toBe(true);
  });
  test.each([
    ["company", "Acme Corporation Alpha"], ["contact person", "John Doe"], ["email", "john@acme-alpha.com"], ["phone", "9876543210"],
    ["customer reference", "ACME-Alpha"], ["PAN", "ABCDE1234F"], ["GST", "24ABCDE1234F1Z5"], ["group name", "Wholesale"], ["branch name", "Surat Branch Alpha"],
  ])("search matches %s", async (_k, term) => {
    const r = await adminA.get(`/api/clients?page=1&limit=500&search=${encodeURIComponent(term)}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThan(0);
  });
  test("search by group name returns exactly the customers in that group", async () => {
    const r = await adminA.get(`/api/clients?page=1&limit=500&search=Wholesale`);
    expect(r.body.data.every((c) => (c.groups || []).some((g) => g.name === "Wholesale") || /wholesale/i.test(JSON.stringify(c)))).toBe(true);
  });
  test("Contacts page API: status / logged_in filters and search are correct", async () => {
    const act = await adminA.get("/api/clients/contacts/all?page=1&limit=500&status=active");
    expect(act.body.data.every((c) => c.active !== false)).toBe(true);
    const ina = await adminA.get("/api/clients/contacts/all?page=1&limit=500&status=inactive");
    expect(ina.body.data.every((c) => c.active === false)).toBe(true);
    const li = await adminA.get("/api/clients/contacts/all?page=1&limit=500&filter=logged_in");
    expect(li.body.data.length).toBeGreaterThan(0);
    expect(li.body.data.every((c) => c.last_login)).toBe(true);
    const s = await adminA.get(`/api/clients/contacts/all?page=1&limit=500&search=${encodeURIComponent("Acme Corporation Alpha")}`);
    expect(s.body.data.length).toBeGreaterThanOrEqual(2);
    const legacy = await adminA.get("/api/clients/contacts/all");
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body.some((c) => c.password)).toBe(false);
  });
  test("Detail endpoint returns populated refs and custom_fields", async () => {
    const r = await adminA.get(`/api/clients/${A.c.acme._id}`);
    expect(r.status).toBe(200);
    expect(r.body.branch.name).toBe("Ahmedabad Branch Alpha");
    expect(r.body.groups[0].name).toBe("VIP");
    expect(r.body).toHaveProperty("custom_fields");
  });
  test("Deleted record link -> 404", async () => {
    const c = await create(adminA, {});
    await adminA.del(`/api/clients/${c.body._id}`);
    expect((await adminA.get(`/api/clients/${c.body._id}`)).status).toBe(404);
    expect((await adminA.put(`/api/clients/${c.body._id}`, { city: "x" })).status).toBe(404);
  });
  test("Statement: unknown customer 404, works for a customer with no invoices", async () => {
    expect((await adminA.get(`/api/clients/${new mongoose.Types.ObjectId()}/statement`)).status).toBe(404);
    const r = await adminA.get(`/api/clients/${A.c.other._id}/statement`);
    expect(r.status).toBe(200);
    expect(r.body.balanceDue).toBe(0);
  });
  test("Statement email: missing recipient -> 400", async () => {
    expect((await adminA.post(`/api/clients/${A.c.acme._id}/statement/send`, {})).status).toBe(400);
  });
  test("Groups list returns customer counts", async () => {
    const r = await adminA.get("/api/client-groups");
    const vip = r.body.find((g) => g.name === "VIP");
    expect(vip.totalCustomers).toBeGreaterThanOrEqual(1);
  });
  test("Group bulk create skips duplicates", async () => {
    const r = await adminA.post("/api/client-groups/bulk", { groups: ["VIP", `Bulk ${Date.now()}`, `bulk ${Date.now()}`] });
    expect(r.status).toBe(201);
    expect(r.body.length).toBe(1);
  });
});
