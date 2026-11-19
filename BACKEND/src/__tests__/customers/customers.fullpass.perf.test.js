/**
 * Customers full test pass — Phase 11 performance (local machine, in-memory MongoDB, 127.0.0.1:5204).
 * 10,000 customers, 30,000 contacts; list / All / search / contacts / import 5,000 rows /
 * 10,000-row export source / statement with 500 invoices / 20 users at once.
 * Numbers are written to test-results/customers/logs/perf.json. Budgets are generous local limits.
 *
 * Run: npx jest src/__tests__/customers/customers.fullpass.perf --runInBand
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

jest.setTimeout(600000);
const BASE = "http://127.0.0.1:5204";
let stack; let A; let tok;
const timings = {};

const timed = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return r;
};
const get = (p, t = tok) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeAll(async () => {
  const { boot } = require("../../testUtils/startCustomersFullpassStack");
  stack = await boot({ log: false, extraCustomers: 0 });
  A = stack.world.A;
  tok = A.users.admin.token;
  const db = mongoose.connection.db;
  const clients = [];
  for (let i = 0; i < 10000; i++) {
    clients.push({ _id: new mongoose.Types.ObjectId(), company: `Perf Customer ${String(i).padStart(5, "0")}`, email: `perf${i}@perf.com`, phonenumber: `9${String(100000000 + i)}`, pan_number: i % 7 === 0 ? "PERFX1234P" : undefined, active: i % 4 !== 0, branch: A.branches[i % 2]._id, groups: [A.groups[i % 2]._id], tenant_id: A.tenantId, admins: [], createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date() });
  }
  await db.collection("clients").insertMany(clients);
  const contacts = [];
  for (let i = 0; i < 30000; i++) contacts.push({ userid: clients[i % 10000]._id, firstname: `First${i}`, lastname: `Last${i}`, email: `pc${i}@perf.com`, is_primary: i < 10000, active: i % 5 !== 0, createdAt: new Date(Date.now() - i * 100) });
  await db.collection("contacts").insertMany(contacts);
  const big = clients[0]._id;
  const invs = [];
  for (let i = 0; i < 500; i++) invs.push({ _id: new mongoose.Types.ObjectId(), client: big, number: `PERF-INV-${i}`, subtotal: 100, total: 100, status: "unpaid", date: new Date(Date.now() - i * 864e5), tenant_id: A.tenantId });
  await db.collection("invoices").insertMany(invs);
  await db.collection("payments").insertMany(invs.slice(0, 250).map((inv) => ({ invoice: inv._id, client: big, amount: 50, date: inv.date, tenant_id: A.tenantId })));
  A.big = big;
});

afterAll(async () => {
  fs.mkdirSync(path.join(__dirname, "../../../../test-results/customers/logs"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "../../../../test-results/customers/logs/perf.json"), JSON.stringify(timings, null, 2));
  console.log("PERF", JSON.stringify(timings));
  if (stack) await stack.stop();
});

test("list page 1 (25 rows) of 10,000 customers < 2 s", async () => {
  const r = await timed("list_page_25", () => get("/api/clients?page=1&limit=25"));
  expect(r.status).toBe(200);
  expect(r.body.total).toBeGreaterThanOrEqual(10000);
  expect(timings.list_page_25).toBeLessThan(2000);
});
test("list page 400 of 10,000 (deep page) < 2 s", async () => {
  const r = await timed("list_deep_page", () => get("/api/clients?page=400&limit=25"));
  expect(r.status).toBe(200);
  expect(timings.list_deep_page).toBeLessThan(2000);
});
test("'All' mode (legacy unpaginated: 10,000 rows, export source) < 15 s", async () => {
  const r = await timed("list_all_10000", () => get("/api/clients"));
  expect(r.status).toBe(200);
  expect(r.body.length).toBeGreaterThanOrEqual(10000);
  timings.list_all_bytes = JSON.stringify(r.body).length;
  expect(timings.list_all_10000).toBeLessThan(15000);
});
test("search by company / phone / group / PAN < 2 s", async () => {
  for (const [k, s] of [["company", "Perf Customer 0999"], ["phone", "9100000500"], ["group", "Wholesale"], ["pan", "PERFX1234P"]]) {
    const r = await timed(`search_${k}`, () => get(`/api/clients?page=1&limit=25&search=${encodeURIComponent(s)}`));
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(timings[`search_${k}`]).toBeLessThan(2000);
  }
});
test("contacts page (30,000 contacts) page 1 and search < 3 s", async () => {
  const r = await timed("contacts_page_25", () => get("/api/clients/contacts/all?page=1&limit=25"));
  expect(r.body.total).toBeGreaterThanOrEqual(30000);
  const s = await timed("contacts_search", () => get("/api/clients/contacts/all?page=1&limit=25&search=Perf%20Customer%2000012"));
  expect(s.status).toBe(200);
  expect(timings.contacts_page_25).toBeLessThan(3000);
  expect(timings.contacts_search).toBeLessThan(3000);
});
test("import 5,000 rows < 30 s", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ "Company Name": `Bulk Import ${i}`, email: `bi${i}@imp.com`, "Phone Number": `98${String(20000000 + i)}`, Branch: "Ahmedabad Branch Alpha" }));
  const r = await timed("import_5000", () => post("/api/clients/import", rows));
  expect(r.status).toBe(200);
  expect(r.body.insertedCount).toBe(5000);
  expect(timings.import_5000).toBeLessThan(30000);
});
test("statement for a customer with 500 invoices < 3 s and correct", async () => {
  const r = await timed("statement_500_invoices", () => get(`/api/clients/${A.big}/statement`));
  expect(r.status).toBe(200);
  expect(r.body.totalInvoiced + r.body.beginningBalance).toBe(50000);
  expect(r.body.balanceDue).toBe(50000 - 12500);
  expect(timings.statement_500_invoices).toBeLessThan(3000);
});
test("20 users at once on the list page: all 200, p95 < 5 s", async () => {
  const toks = [A.users.admin, A.users.full, A.users.viewGlobal, A.users.viewOwn].map((u) => u.token);
  const t0 = performance.now();
  const durs = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const s = performance.now();
    const r = await get(`/api/clients?page=${(i % 5) + 1}&limit=25&search=${i % 2 ? "Perf" : ""}`, toks[i % 4]);
    expect(r.status).toBe(200);
    return performance.now() - s;
  }));
  timings.concurrent20_wall = Math.round(performance.now() - t0);
  durs.sort((a, b) => a - b);
  timings.concurrent20_p50 = Math.round(durs[9]);
  timings.concurrent20_p95 = Math.round(durs[18]);
  expect(timings.concurrent20_p95).toBeLessThan(5000);
});
