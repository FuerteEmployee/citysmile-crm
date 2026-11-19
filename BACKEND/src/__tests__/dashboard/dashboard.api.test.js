// DASHBOARD module — API, security, role, plan and company-separation checks for every
// endpoint the dashboard page calls (there is no dashboard endpoint of its own).
// In-memory MongoDB only (testUtils/dashboardTestApp.js). Each test states the EXPECTED
// (business-rule) behaviour; a failing test = a finding for the report.
// Test names start with "[area]" so the report can group them.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, client } = require("../../testUtils/dashboardTestApp");

let S;
const db = () => mongoose.connection.db;

// The exact calls Dashboard.tsx makes (path, plan module, permission key).
const DASH_ENDPOINTS = [
  ["/api/invoices", "finance", "Invoices"],
  ["/api/estimates", "estimates", "Estimates"],
  ["/api/proposals", "proposals", "Proposals"],
  ["/api/quotations", "sales", "Quotations"],
  ["/api/tasks", "tasks", "Tasks"],
  ["/api/projects", "projects", "Projects"],
  ["/api/tickets", "support", "Support"],
  ["/api/announcements", "announcements", "Announcements"],
  ["/api/leads", "leads", "Leads"],
  ["/api/expenses", "expenses", "Expenses"],
  ["/api/activity-logs", "utility", "Activity Log"],
];
const CORE = ["/api/todos", "/api/reminders?status=pending"];
const ALL = [...DASH_ENDPOINTS.map((e) => e[0]), ...CORE];

beforeAll(async () => { ({ seed: S } = await start()); });
afterAll(stop);

const as = (u) => client(u.token);

describe("[Guard]", () => {
  test("tests run on an in-memory 127.0.0.1 MongoDB", () => {
    expect(mongoose.connection.host).toBe("127.0.0.1");
    expect(process.env.MONGO_URI.startsWith("mongodb://127.0.0.1")).toBe(true);
  });
});

describe("[API] status codes", () => {
  test.each(ALL)("%s as company admin -> 200 with an array", async (p) => {
    const r = await as(S.A.admin).get(p);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
  test.each(ALL)("%s with no token -> 401", async (p) => {
    expect((await client(null).get(p)).status).toBe(401);
  });
  test.each(ALL)("%s with a bad token -> 401", async (p) => {
    expect((await client(null, "Bearer not.a.real.token").get(p)).status).toBe(401);
  });
  test.each(ALL)("%s with a token signed by another secret -> 401", async (p) => {
    const forged = jwt.sign({ id: String(S.A.admin.id), role: "staff" }, "wrong-secret");
    expect((await client(forged).get(p)).status).toBe(401);
  });
  test.each(ALL)("%s with a token for a deleted user -> 401", async (p) => {
    const ghost = jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "staff" }, process.env.JWT_SECRET);
    expect((await client(ghost).get(p)).status).toBe(401);
  });
});

describe("[Todo] field rules and CRUD (My To Do Items)", () => {
  test("create with the payload the dashboard sends {title, completed, priority} -> 201 and the text is saved", async () => {
    const r = await as(S.A.admin).post("/api/todos", { title: "Call the bank", completed: false, priority: "Medium" });
    expect(r.status).toBe(201);
    const saved = await db().collection("todos").findOne({ staff: S.A.admin.id, $or: [{ description: "Call the bank" }, { title: "Call the bank" }] });
    expect(saved).not.toBeNull();
  });
  test("create with description -> 201, saved for the current user and company only", async () => {
    const r = await as(S.A.vglobal = S.A.users.vglobal).post("/api/todos", { description: "Own todo", staff: String(S.A.admin.id), tenant_id: String(S.B.tenantId) });
    expect(r.status).toBe(201);
    const saved = await db().collection("todos").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(String(saved.staff)).toBe(String(S.A.users.vglobal.id));
    expect(String(saved.tenant_id)).toBe(String(S.A.tenantId));
  });
  test("empty body -> 400 (not 500)", async () => {
    expect((await as(S.A.admin).post("/api/todos", {})).status).toBe(400);
  });
  test("only spaces -> 400", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: "     " })).status).toBe(400);
  });
  test("leading/trailing spaces are trimmed", async () => {
    const r = await as(S.A.admin).post("/api/todos", { description: "  padded  " });
    expect(r.status).toBe(201);
    expect(r.body.description).toBe("padded");
  });
  test("255 characters -> 201 (max length allowed)", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: "x".repeat(255) })).status).toBe(201);
  });
  test("256 characters -> 400 (max 255, PROPOSED rule)", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: "x".repeat(256) })).status).toBe(400);
  });
  test("10,000 characters -> 400", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: "y".repeat(10000) })).status).toBe(400);
  });
  test("object instead of text {$ne:null} -> 400 (not 500)", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: { $ne: null } })).status).toBe(400);
  });
  test("duplicate text is allowed (no uniqueness rule)", async () => {
    expect((await as(S.A.admin).post("/api/todos", { description: "dup" })).status).toBe(201);
    expect((await as(S.A.admin).post("/api/todos", { description: "dup" })).status).toBe(201);
  });
  test("tick with the payload the dashboard sends {completed:true} -> finished saved in DB", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "tick me" });
    await as(S.A.admin).put(`/api/todos/${c.body._id}`, { completed: true });
    const saved = await db().collection("todos").findOne({ _id: new mongoose.Types.ObjectId(c.body._id) });
    expect(saved.finished).toBe(true);
  });
  test("tick with {finished:true} -> saved, datefinished set; untick -> finished false", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "tick me 2" });
    const r = await as(S.A.admin).put(`/api/todos/${c.body._id}`, { finished: true });
    expect(r.status).toBe(200);
    expect(r.body.finished).toBe(true);
    expect(r.body.datefinished).toBeTruthy();
    const u = await as(S.A.admin).put(`/api/todos/${c.body._id}`, { finished: false });
    expect(u.body.finished).toBe(false);
  });
  test("edit applies the same rules: only spaces -> 400", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "edit rules" });
    expect((await as(S.A.admin).put(`/api/todos/${c.body._id}`, { description: "   " })).status).toBe(400);
  });
  test("edit applies the same rules: 256 chars -> 400", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "edit rules 2" });
    expect((await as(S.A.admin).put(`/api/todos/${c.body._id}`, { description: "z".repeat(256) })).status).toBe(400);
  });
  test("[Security] edit cannot move a todo to another user/company (staff, tenant_id ignored)", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "mass assign" });
    await as(S.A.admin).put(`/api/todos/${c.body._id}`, { staff: String(S.B.admin.id), tenant_id: String(S.B.tenantId) });
    const saved = await db().collection("todos").findOne({ _id: new mongoose.Types.ObjectId(c.body._id) });
    expect(String(saved.staff)).toBe(String(S.A.admin.id));
    expect(String(saved.tenant_id)).toBe(String(S.A.tenantId));
  });
  test("PUT with a malformed id -> 400/404 (not 500)", async () => {
    expect([400, 404]).toContain((await as(S.A.admin).put("/api/todos/not-an-id", { finished: true })).status);
  });
  test("[Security] PUT with a NoSQL id {\"$ne\":null} -> 400/404 (not 500)", async () => {
    expect([400, 404]).toContain((await as(S.A.admin).put(`/api/todos/${encodeURIComponent('{"$ne":null}')}`, { finished: true })).status);
  });
  test("DELETE with a malformed id -> 400/404 (not 500)", async () => {
    expect([400, 404]).toContain((await as(S.A.admin).del("/api/todos/not-an-id")).status);
  });
  test("list returns only the logged-in user's todos", async () => {
    const r = await as(S.A.admin).get("/api/todos");
    expect(r.body.every((t) => String(t.staff) === String(S.A.admin.id))).toBe(true);
  });
  test("[Security] another company's admin cannot see, tick or delete my todo -> 404", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "A secret todo" });
    const list = await as(S.B.admin).get("/api/todos");
    expect(list.body.some((t) => t._id === c.body._id)).toBe(false);
    expect((await as(S.B.admin).put(`/api/todos/${c.body._id}`, { finished: true })).status).toBe(404);
    expect((await as(S.B.admin).del(`/api/todos/${c.body._id}`)).status).toBe(404);
  });
  test("[Security] a colleague in the same company cannot tick my todo -> 404", async () => {
    const c = await as(S.A.admin).post("/api/todos", { description: "colleague check" });
    expect((await as(S.A.users.full).put(`/api/todos/${c.body._id}`, { finished: true })).status).toBe(404);
  });
  test("XSS text is stored as plain text (escaped on display — checked in UI test)", async () => {
    const r = await as(S.A.admin).post("/api/todos", { description: "<img src=x onerror=alert(1)>" });
    expect(r.status).toBe(201);
  });
});

describe("[Roles] permission gating on the dashboard's data calls", () => {
  test.each(DASH_ENDPOINTS)("%s as staff with NO permission -> 403", async (p) => {
    expect((await as(S.A.users.none).get(p)).status).toBe(403);
  });
  test.each(DASH_ENDPOINTS)("%s as staff with View(Global) -> 200", async (p) => {
    expect((await as(S.A.users.vglobal).get(p)).status).toBe(200);
  });
  test("My Reminders: a staff member only receives their OWN pending reminders", async () => {
    const r = await as(S.A.users.vglobal).get("/api/reminders?status=pending");
    expect(r.status).toBe(200);
    expect(r.body.every((x) => String(x.staff?._id || x.staff) === String(S.A.users.vglobal.id))).toBe(true);
  });
  test("My Reminders: staff with NO permissions does not receive other people's reminders", async () => {
    const r = await as(S.A.users.none).get("/api/reminders?status=pending");
    expect(r.body.filter((x) => String(x.staff?._id || x.staff) !== String(S.A.users.none.id)).length).toBe(0);
  });
  test("pending reminders exclude completed ones", async () => {
    const r = await as(S.A.admin).get("/api/reminders?status=pending");
    expect(r.body.some((x) => x.description === "Admin completed reminder")).toBe(false);
  });
});

describe("[Own vs Global] View (Own) staff see only their own records", () => {
  const own = (path) => as(S.A.users.vown).get(path);
  test("invoices: only the 1 invoice they created", async () => {
    const r = await own("/api/invoices");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(S.A.EXPECTED.vownOwn.invoices);
  });
  test("leads: only the 1 lead assigned to / added by them", async () => {
    const r = await own("/api/leads");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(S.A.EXPECTED.vownOwn.leads);
  });
  test("tasks: only the 1 task they are assigned to", async () => {
    const r = await own("/api/tasks");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(S.A.EXPECTED.vownOwn.tasks);
  });
  test("projects: only the 1 project they are a team member of", async () => {
    const r = await own("/api/projects");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(S.A.EXPECTED.vownOwn.projects);
  });
  test("expenses: none of the admin's expenses", async () => {
    const r = await own("/api/expenses");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
  });
  test("estimates: none created by others", async () => {
    const r = await own("/api/estimates");
    expect(r.status).toBe(200);
    expect((r.body.data || r.body).length).toBe(0);
  });
  test("proposals: none created by others", async () => {
    const r = await own("/api/proposals");
    expect(r.status).toBe(200);
    expect((r.body.data || r.body).length).toBe(0);
  });
  test("quotations: none created by others", async () => {
    const r = await own("/api/quotations");
    expect(r.status).toBe(200);
    expect((r.body.data || r.body).length).toBe(0);
  });
  test("View(Global) staff see the whole company (13 invoices)", async () => {
    expect((await as(S.A.users.vglobal).get("/api/invoices")).body.length).toBe(13);
  });
});

describe("[Plan] module switched off in the plan", () => {
  test.each(DASH_ENDPOINTS)("%s for a company whose plan has the module off -> 403 MODULE_DISABLED", async (p) => {
    const r = await as(S.OFF.admin).get(p);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_DISABLED");
  });
  test.each(CORE)("%s (core, never gated) stays 200 when every module is off", async (p) => {
    expect((await as(S.OFF.admin).get(p)).status).toBe(200);
  });
});

describe("[Expiry] plan ended more than 7 days ago (past grace)", () => {
  test.each(DASH_ENDPOINTS.map((e) => e[0]))("%s is blocked on the API too (402/403), not only in the browser", async (p) => {
    const r = await as(S.EXPIRED.admin).get(p);
    expect([402, 403]).toContain(r.status);
  });
  test("company inside the grace period still works (200)", async () => {
    expect((await as(S.GRACE.admin).get("/api/todos")).status).toBe(200);
  });
});

describe("[Separation] company A never receives company B data", () => {
  test.each(ALL)("%s as A admin contains no row of another company", async (p) => {
    const r = await as(S.A.admin).get(p);
    const rows = r.body.data || r.body;
    expect(rows.every((x) => !x.tenant_id || String(x.tenant_id) === String(S.A.tenantId))).toBe(true);
  });
  test.each(ALL)("%s as B admin contains no row of company A", async (p) => {
    const r = await as(S.B.admin).get(p);
    const rows = r.body.data || r.body;
    expect(rows.every((x) => !x.tenant_id || String(x.tenant_id) === String(S.B.tenantId))).toBe(true);
  });
  test("A admin opening B's invoice by id -> 404", async () => {
    const bInv = await db().collection("invoices").findOne({ tenant_id: S.B.tenantId });
    expect((await as(S.A.admin).get(`/api/invoices/${bInv._id}`)).status).toBe(404);
  });
  test("[Security] NoSQL injection in invoices filter ?client[$ne]=x does not leak other companies", async () => {
    const r = await as(S.A.admin).get("/api/invoices?client[$ne]=000000000000000000000000");
    expect(r.status).not.toBe(500);
    const rows = Array.isArray(r.body) ? r.body : [];
    expect(rows.every((x) => String(x.tenant_id) === String(S.A.tenantId))).toBe(true);
  });
  test("[Security] NoSQL injection in reminders ?rel_id[$ne]= stays inside the company", async () => {
    const r = await as(S.A.admin).get("/api/reminders?rel_id[$ne]=000000000000000000000000");
    expect(r.status).not.toBe(500);
    const rows = Array.isArray(r.body) ? r.body : [];
    expect(rows.every((x) => String(x.tenant_id) === String(S.A.tenantId))).toBe(true);
  });
  test("Rudraverse (info@trinetratechnoworld.com) gets the same dashboard data shape as any company (only own data)", async () => {
    const r = await as(S.R.admin).get("/api/invoices");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(3);
    expect(r.body.every((x) => String(x.tenant_id) === String(S.R.tenantId))).toBe(true);
  });
});

describe("[Read-only] loading the dashboard must not change data", () => {
  test("GET /api/invoices does not rewrite an unpaid past-due invoice to 'overdue'", async () => {
    const id = S.A.invoiceIds["A-PASTDUE"];
    const before = await db().collection("invoices").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(before.status).toBe("unpaid");
    await as(S.A.admin).get("/api/invoices");
    const after = await db().collection("invoices").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(after.status).toBe("unpaid");
  });
});

describe("[Data] fields the dashboard widgets read", () => {
  test("Announcements created through the API record the author (created_by) so the name can be shown", async () => {
    const r = await as(S.A.admin).post("/api/announcements", { name: "API ann", message: "hello" });
    expect(r.status).toBe(201);
    const saved = await db().collection("announcements").findOne({ _id: new mongoose.Types.ObjectId(r.body._id) });
    expect(String(saved.created_by)).toBe(String(S.A.admin.id));
  });
  test("Announcements: staff without View Announcements -> 403 (so the dashboard must not request it)", async () => {
    expect((await as(S.A.users.none).get("/api/announcements")).status).toBe(403);
  });
  test("Activity log rows carry the staff name under staffid (what the dashboard must read)", async () => {
    const r = await as(S.A.admin).get("/api/activity-logs");
    expect(r.body[0].staffid.firstname).toBeTruthy();
    expect(r.body[0].staff).toBeUndefined();
    expect(r.body[0].additional_data).toBeUndefined();
  });
  test("Invoice list carries no paid-amount/balance field, so 'Outstanding' cannot subtract payments", async () => {
    const r = await as(S.A.admin).get("/api/invoices");
    const part = r.body.find((i) => i.number === "A-PART");
    const hasBalance = ["balance", "amount_due", "amountDue", "total_paid", "amount_paid", "paid_amount"].some((k) => k in part);
    expect(hasBalance).toBe(true);
  });
  test("Leads expose `converted` (not `isConverted`)", async () => {
    const r = await as(S.A.admin).get("/api/leads");
    expect(r.body.filter((l) => l.converted === true).length).toBe(3);
    expect(r.body.some((l) => "isConverted" in l)).toBe(false);
  });
  test("Tickets come back newest first (dashboard shows the first 5 as 'recent')", async () => {
    const r = await as(S.A.admin).get("/api/tickets");
    expect(r.body.slice(0, 5).map((t) => t.subject)).toEqual(S.A.EXPECTED.newestTickets);
  });
  test("Tasks come back newest first (dashboard shows the first 5 unfinished)", async () => {
    const r = await as(S.A.admin).get("/api/tasks");
    const open = r.body.filter((t) => t.status !== 5).slice(0, 5).map((t) => t.name);
    expect(open).toEqual(S.A.EXPECTED.newestOpenTasks);
  });
  test("Quotations come back newest first", async () => {
    const r = await as(S.A.admin).get("/api/quotations");
    expect(r.body.slice(0, 5).map((q) => q.number)).toEqual(S.A.EXPECTED.newestQuotations);
  });
});

describe("[Performance] list endpoints with 5,000 invoices / 5,000 leads / 2,000 tasks", () => {
  const timings = {};
  beforeAll(async () => {
    const { seedBulk } = require("../../testUtils/dashboardSeed");
    await seedBulk(S.B.tenantId, S.B.admin.id);
  }, 120000);
  test.each(["/api/invoices", "/api/leads", "/api/tasks"])("%s returns the full list in < 5 s (local)", async (p) => {
    const r0 = Date.now();
    const r = await as(S.B.admin).get(p);
    const ms = Date.now() - r0;
    timings[p] = { ms, rows: r.body.length, bytes: JSON.stringify(r.body).length };
    console.log(`[PERF] ${p}: ${ms} ms, ${r.body.length} rows, ${(timings[p].bytes / 1024 / 1024).toFixed(2)} MB`);
    expect(r.status).toBe(200);
    expect(ms).toBeLessThan(5000);
  });
  test("20 users loading the dashboard's 3 big lists at once: every call 200, slowest < 15 s", async () => {
    const t0 = Date.now();
    const calls = [];
    for (let i = 0; i < 20; i++) for (const p of ["/api/invoices", "/api/leads", "/api/tasks"]) calls.push(as(S.B.admin).get(p).then((r) => ({ s: r.status, ms: Date.now() - t0 })));
    const out = await Promise.all(calls);
    const slowest = Math.max(...out.map((o) => o.ms));
    console.log(`[PERF] 20 concurrent users x 3 lists: slowest ${slowest} ms, statuses ${[...new Set(out.map((o) => o.s))]}`);
    expect(out.every((o) => o.s === 200)).toBe(true);
    expect(slowest).toBeLessThan(15000);
  }, 180000);
});
