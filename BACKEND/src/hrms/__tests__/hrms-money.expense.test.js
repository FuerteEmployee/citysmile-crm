// HRMS Part C — Expense Management / My Expenses (rules 21-23, field rules, suspected bugs 9, 22).
// Each test states the EXPECTED rule (PROPOSED = real). A failing test = an app bug.
const mongoose = require("mongoose");
const { start, stop, seedTenant, seedStandardPeople, client } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(120000);
let A, B;
const exp = (p, extra = {}) => p.api.post("/expenses", { description: "Taxi to client", amount: 450.5, category: "Travel", paymentMethod: "UPI", ...extra });
const getRaw = (id) => mongoose.connection.db.collection("hrmsexpenses").findOne({ _id: new mongoose.Types.ObjectId(id) });

beforeAll(async () => {
  await start();
  A = await seedStandardPeople(await seedTenant("ExpA"));
  B = await seedStandardPeople(await seedTenant("ExpB"));
  await A.api.post("/expense-categories", { name: "Travel" });
  await A.api.post("/expense-categories", { name: "Food" });
});
afterAll(stop);

describe("Create — field rules (description, amount ≥ 0.01 max 2 decimals, payment mode, category from list)", () => {
  test("[+] valid expense → 201, Pending, createdBy = the employee", async () => {
    const r = await exp(A.people.emp);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: "Pending", amount: 450.5, paymentMethod: "UPI" });
    expect(String(r.body.data.createdBy)).toBe(A.people.emp.userId);
    const raw = await getRaw(r.body.data._id);
    expect(String(raw.tenant_id)).toBe(String(A.tenantId));
  });
  test("[+] client cannot create it already Approved (status forced to Pending)", async () => {
    const r = await exp(A.people.emp, { status: "Approved" });
    expect(r.body.data.status).toBe("Pending");
  });
  test("[BUG?] client cannot inject approvedBy / paidAt / createdBy on create", async () => {
    const r = await exp(A.people.emp, { approvedBy: A.admin.userId, paidAt: "2026-01-01", createdBy: A.people.emp2.userId });
    const raw = await getRaw(r.body.data._id);
    expect({ approvedBy: raw.approvedBy ? String(raw.approvedBy) : null, paidAt: raw.paidAt || null, createdBy: String(raw.createdBy) })
      .toEqual({ approvedBy: null, paidAt: null, createdBy: A.people.emp.userId });
  });
  test.each([["0", 0], ["-5", -5], ["abc", "abc"], ["empty", ""]])("[+] amount %s → 400", async (_l, v) => {
    expect((await exp(A.people.emp, { amount: v })).status).toBe(400);
  });
  test.each([["10.555", 10.555], ["0.001", 0.001]])("[BUG?] amount with more than 2 decimals (%s) → 400", async (_l, v) => {
    expect((await exp(A.people.emp, { amount: v })).status).toBe(400);
  });
  test("[+] description missing → 400", async () => {
    expect((await exp(A.people.emp, { description: "" })).status).toBe(400);
  });
  test("[BUG?] description of only spaces → 400", async () => {
    expect((await exp(A.people.emp, { description: "    " })).status).toBe(400);
  });
  test("[+] payment mode not in Cash/Card/UPI/Net Banking/Cheque → 400", async () => {
    expect((await exp(A.people.emp, { paymentMethod: "Bitcoin" })).status).toBe(400);
  });
  test.each(["Cash", "Card", "UPI", "Net Banking", "Cheque"])("[+] payment mode %s accepted", async (m) => {
    expect((await exp(A.people.emp, { paymentMethod: m })).status).toBe(201);
  });
  test("[BUG?] category must be one of the company's categories (free text 'Casino' → 400)", async () => {
    expect((await exp(A.people.emp, { category: "Casino" })).status).toBe(400);
  });
  test("[BUG?] category from ANOTHER company's list → 400", async () => {
    await B.api.post("/expense-categories", { name: "B-Only-Cat" });
    expect((await exp(A.people.emp, { category: "B-Only-Cat" })).status).toBe(400);
  });
  test("[+] category missing → 400", async () => {
    expect((await exp(A.people.emp, { category: undefined })).status).toBe(400);
  });
});

describe("Rule 23 — employee sees only own expenses (API, not just the screen)", () => {
  let colleagueExp;
  beforeAll(async () => { colleagueExp = (await exp(A.people.emp2, { description: "Colleague secret claim" })).body.data._id; });
  test("[BUG?] GET /expenses as a normal employee returns only their own rows", async () => {
    const r = await A.people.emp.api.get("/expenses");
    const others = r.body.data.filter((e) => String(e.createdBy?._id || e.createdBy) !== A.people.emp.userId);
    expect(others.length).toBe(0);
  });
  test("[BUG?] GET /expenses/:id of a colleague's expense → 403/404", async () => {
    expect([403, 404]).toContain((await A.people.emp.api.get(`/expenses/${colleagueExp}`)).status);
  });
  test("[+] expense manager sees everyone's", async () => {
    const r = await A.people.expmgr.api.get("/expenses");
    expect(r.body.data.some((e) => String(e.createdBy?._id) === A.people.emp2.userId)).toBe(true);
  });
  test("[+] other company never sees company A rows (list + by id)", async () => {
    const r = await B.api.get("/expenses");
    expect(r.body.data.some((e) => String(e.tenant_id) === String(A.tenantId))).toBe(false);
    expect((await B.api.get(`/expenses/${colleagueExp}`)).status).toBe(404);
  });
  test("[+] status filter returns only that status", async () => {
    const r = await A.api.get("/expenses?status=Pending");
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((e) => e.status === "Pending")).toBe(true);
  });
  test("[BUG?] NoSQL operator in a filter (status[$ne]=Pending) is rejected", async () => {
    expect((await A.api.get("/expenses?status[$ne]=Pending")).status).toBe(400);
  });
});

describe("Rule 22 — employee can edit/delete only their OWN PENDING expense", () => {
  let mine, colleague;
  beforeEach(async () => {
    mine = (await exp(A.people.emp)).body.data._id;
    colleague = (await exp(A.people.emp2)).body.data._id;
  });
  test("[+] edit own pending expense → 200, value saved", async () => {
    const r = await A.people.emp.api.put(`/expenses/${mine}`, { amount: 500 });
    expect(r.status).toBe(200);
    expect((await getRaw(mine)).amount).toBe(500);
  });
  test("[BUG?] edit a colleague's expense → 403 and not changed", async () => {
    const r = await A.people.emp.api.put(`/expenses/${colleague}`, { amount: 1 });
    expect({ status: r.status, amount: (await getRaw(colleague)).amount }).toEqual({ status: 403, amount: 450.5 });
  });
  test("[BUG?] delete a colleague's pending expense → 403 and still there", async () => {
    const r = await A.people.emp.api.del(`/expenses/${colleague}`);
    expect({ status: r.status, exists: !!(await getRaw(colleague)) }).toEqual({ status: 403, exists: true });
  });
  test("[BUG?] after approval the employee cannot change the amount", async () => {
    await A.api.patch(`/expenses/${mine}/status`, { status: "Approved" });
    const r = await A.people.emp.api.put(`/expenses/${mine}`, { amount: 99999 });
    expect({ status: r.status >= 400 ? "refused" : "allowed", amount: (await getRaw(mine)).amount }).toEqual({ status: "refused", amount: 450.5 });
  });
  test("[+] approved expense cannot be deleted (400)", async () => {
    await A.api.patch(`/expenses/${mine}/status`, { status: "Approved" });
    expect((await A.people.emp.api.del(`/expenses/${mine}`)).status).toBe(400);
  });
  test("[+] edit cannot change status/tenant via PUT", async () => {
    await A.people.emp.api.put(`/expenses/${mine}`, { status: "Paid", tenant_id: String(B.tenantId) });
    const raw = await getRaw(mine);
    expect(raw.status).toBe("Pending");
    expect(String(raw.tenant_id)).toBe(String(A.tenantId));
  });
  test("[BUG?] edit applies the same field rules (amount 10.555 → 400)", async () => {
    expect((await A.people.emp.api.put(`/expenses/${mine}`, { amount: 10.555 })).status).toBe(400);
  });
  test("[BUG?] edit applies the category rule (Casino → 400)", async () => {
    expect((await A.people.emp.api.put(`/expenses/${mine}`, { category: "Casino" })).status).toBe(400);
  });
});

describe("Rule 21 — status flow only Pending → Approved/Rejected → (Approved →) Paid", () => {
  const mk = async () => (await exp(A.people.emp)).body.data._id;
  const st = (id, s, who = A.api) => who.patch(`/expenses/${id}/status`, { status: s });
  test("[+] Pending → Approved → Paid (paidAt set)", async () => {
    const id = await mk();
    expect((await st(id, "Approved")).status).toBe(200);
    expect((await st(id, "Paid")).status).toBe(200);
    expect((await getRaw(id)).paidAt).toBeTruthy();
  });
  test("[+] Pending → Rejected", async () => {
    expect((await st(await mk(), "Rejected")).status).toBe(200);
  });
  test.each([
    ["Pending → Paid", ["Paid"]],
    ["Rejected → Paid", ["Rejected", "Paid"]],
    ["Rejected → Approved", ["Rejected", "Approved"]],
    ["Paid → Pending", ["Approved", "Paid", "Pending"]],
    ["Paid → Rejected", ["Approved", "Paid", "Rejected"]],
    ["Approved → Pending", ["Approved", "Pending"]],
  ])("[BUG?] %s is refused (400)", async (_l, steps) => {
    const id = await mk();
    let last;
    for (const s of steps) last = await st(id, s);
    expect(last.status).toBe(400);
  });
  test("[+] invalid status value → 400", async () => {
    expect((await st(await mk(), "Done")).status).toBe(400);
  });
});

describe("Approvals — who may approve", () => {
  test("[+] employee cannot approve own expense (403)", async () => {
    const id = (await exp(A.people.emp)).body.data._id;
    expect((await A.people.emp.api.patch(`/expenses/${id}/status`, { status: "Approved" })).status).toBe(403);
  });
  test("[+] expense manager approves a colleague's expense (200) but not own (403)", async () => {
    const other = (await exp(A.people.emp)).body.data._id;
    const own = (await exp(A.people.expmgr)).body.data._id;
    expect((await A.people.expmgr.api.patch(`/expenses/${other}/status`, { status: "Approved" })).status).toBe(200);
    expect((await A.people.expmgr.api.patch(`/expenses/${own}/status`, { status: "Approved" })).status).toBe(403);
  });
  test("[+] supervisor approves own-branch staff (200), not other branch (403)", async () => {
    const b1 = (await exp(A.people.emp)).body.data._id;
    const b2 = (await exp(A.people.emp2)).body.data._id;
    expect((await A.people.sup.api.patch(`/expenses/${b1}/status`, { status: "Approved" })).status).toBe(200);
    expect((await A.people.sup.api.patch(`/expenses/${b2}/status`, { status: "Approved" })).status).toBe(403);
  });
  test("[+] screen-only permission user (desync) cannot approve via API (403)", async () => {
    const id = (await exp(A.people.emp)).body.data._id;
    expect((await A.people.desync.api.patch(`/expenses/${id}/status`, { status: "Approved" })).status).toBe(403);
  });
  test("[+] other company's admin → 404", async () => {
    const id = (await exp(A.people.emp)).body.data._id;
    expect((await B.api.patch(`/expenses/${id}/status`, { status: "Approved" })).status).toBe(404);
    expect((await B.api.put(`/expenses/${id}`, { amount: 1 })).status).toBe(404);
    expect((await B.api.del(`/expenses/${id}`)).status).toBe(404);
  });
});

describe("Expense categories", () => {
  test("[+] employee cannot create a category (403); manager can (201)", async () => {
    expect((await A.people.emp.api.post("/expense-categories", { name: "Emp cat" })).status).toBe(403);
    expect((await A.people.expmgr.api.post("/expense-categories", { name: "Mgr cat" })).status).toBe(201);
  });
  test("[+] duplicate name in same company → 400, in another company → 201", async () => {
    expect((await A.api.post("/expense-categories", { name: "Travel" })).status).toBe(400);
    expect((await B.api.post("/expense-categories", { name: "Travel" })).status).toBe(201);
  });
  test("[+] other company cannot edit / delete my category (404)", async () => {
    const c = (await A.api.post("/expense-categories", { name: "Edit me" })).body.data;
    expect((await B.api.put(`/expense-categories/${c._id}`, { name: "hijack" })).status).toBe(404);
    expect((await B.api.del(`/expense-categories/${c._id}`)).status).toBe(404);
  });
});

describe("API basics", () => {
  test("[+] no token / bad token → 401", async () => {
    expect((await client(null).get("/expenses")).status).toBe(401);
    expect((await client("abc").get("/expenses")).status).toBe(401);
  });
  test("[+] malformed id → 4xx (not 500)", async () => {
    const r = await A.api.get("/expenses/not-an-id");
    expect(r.status).toBeLessThan(500);
  });
  test("[+] XSS text stored as plain text", async () => {
    const x = "<img src=x onerror=alert(1)>";
    const r = await exp(A.people.emp, { description: x, notes: "<script>alert(1)</script>" });
    expect(r.body.data.description).toBe(x);
  });
});

describe("Integration — Expenses → Payroll", () => {
  test("[INFO/BUG?] an approved (unpaid) expense claim appears on the employee's payslip as a reimbursement", async () => {
    const P = await seedTenant("ExpPay");
    const e = await P.addPerson("claimer", { salaryAmount: 30000 });
    await P.api.post("/expense-categories", { name: "Travel" });
    const id = (await exp(e)).body.data._id;
    await P.api.patch(`/expenses/${id}/status`, { status: "Approved" });
    const g = await P.api.post("/payroll/generate", { month: 9, year: 2026 });
    const rec = g.body.data.find((r) => String(r.employeeId) === e.userId);
    expect((rec.additions || []).some((a) => /expense|reimburse/i.test(a.label))).toBe(true);
  });
});
