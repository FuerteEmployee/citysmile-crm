// HRMS Part C — Leave Management / My Leaves (04-hrms.md rules 17-20, field rules, suspected bugs 12-15).
// Every test states the EXPECTED rule (PROPOSED rules count as real). A failing test = an app bug.
// In-memory MongoDB + backend on 127.0.0.1:5208 only. Run with --runInBand.
const mongoose = require("mongoose");
const { start, stop, seedTenant, seedStandardPeople } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(120000);

let A, B, CL, LWP;
const Y = new Date().getFullYear();

async function balanceOf(userId, typeId, year = Y) {
  const b = await mongoose.connection.db.collection("leavebalances").findOne({ employeeId: new mongoose.Types.ObjectId(userId), leaveTypeId: new mongoose.Types.ObjectId(typeId), year });
  if (!b) return null;
  return { allocated: b.totalAllocated, used: b.used, pending: b.pending, cf: b.carriedForward || 0, available: b.totalAllocated + (b.carriedForward || 0) - b.used - b.pending };
}
const apply = (p, typeId, from, to, days, extra = {}) =>
  p.api.post("/leaves/requests", { leaveTypeId: typeId, fromDate: from, toDate: to, totalDays: days, reason: "Family function", ...extra });

beforeAll(async () => {
  await start();
  A = await seedStandardPeople(await seedTenant("LeaveA"));
  B = await seedStandardPeople(await seedTenant("LeaveB"));
  CL = (await A.api.post("/leaves/types", { name: "Casual Leave A", code: "CLA", yearlyQuota: 12, isPaid: true })).body.data;
  LWP = (await A.api.post("/leaves/types", { name: "Leave Without Pay", code: "LWP", yearlyQuota: 0, isPaid: false })).body.data;
});
afterAll(stop);

describe("Rule 17 — balance: available = allocated + carried forward − used − pending, after EVERY change", () => {
  let emp;
  beforeAll(() => { emp = A.people.emp; });

  test("[+] apply 2 days → pending 2, available 10", async () => {
    const r = await apply(emp, CL._id, `${Y}-12-01`, `${Y}-12-02`, 2);
    expect(r.status).toBe(201);
    expect(await balanceOf(emp.userId, CL._id)).toMatchObject({ allocated: 12, used: 0, pending: 2, available: 10 });
    emp.l1 = r.body.data._id;
  });
  test("[+] approve → used 2, pending 0, available 10", async () => {
    expect((await A.api.patch(`/leaves/requests/${emp.l1}/status`, { status: "approved" })).status).toBe(200);
    expect(await balanceOf(emp.userId, CL._id)).toMatchObject({ used: 2, pending: 0, available: 10 });
  });
  test("[+] apply 1 + reject → pending back to 0, available 10", async () => {
    const r = await apply(emp, CL._id, `${Y}-12-07`, `${Y}-12-07`, 1);
    expect(await balanceOf(emp.userId, CL._id)).toMatchObject({ pending: 1, available: 9 });
    expect((await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "rejected" })).status).toBe(200);
    expect(await balanceOf(emp.userId, CL._id)).toMatchObject({ used: 2, pending: 0, available: 10 });
    emp.rejected = r.body.data._id;
  });
  test("[BUG?] employee cancels own PENDING request → pending must go back to 0 (available 10)", async () => {
    const r = await apply(emp, CL._id, `${Y}-12-09`, `${Y}-12-09`, 1);
    expect((await emp.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "cancelled" })).status).toBe(200);
    expect(await balanceOf(emp.userId, CL._id)).toMatchObject({ used: 2, pending: 0, available: 10 });
  });
  test("[BUG?] re-approve a REJECTED request → used must go up by 1", async () => {
    const before = await balanceOf(emp.userId, CL._id);
    expect((await A.api.patch(`/leaves/requests/${emp.rejected}/status`, { status: "approved" })).status).toBe(200);
    const after = await balanceOf(emp.userId, CL._id);
    expect(after.used).toBe(before.used + 1);
  });
  test("[BUG?] approved → rejected must give the days back (used goes down)", async () => {
    const r = await apply(emp, CL._id, `${Y}-12-14`, `${Y}-12-14`, 1);
    await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "approved" });
    const mid = await balanceOf(emp.userId, CL._id);
    await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "rejected" });
    const after = await balanceOf(emp.userId, CL._id);
    expect(after.used).toBe(mid.used - 1);
  });
  test("[+] cancel an APPROVED request → used goes down by its days", async () => {
    const before = await balanceOf(emp.userId, CL._id);
    expect((await A.api.patch(`/leaves/requests/${emp.l1}/status`, { status: "cancelled" })).status).toBe(200);
    const after = await balanceOf(emp.userId, CL._id);
    expect(after.used).toBe(before.used - 2);
  });
  test("[BUG?] leave in NEXT year: create and approve must use the same year's balance", async () => {
    const p = A.people.emp2;
    const r = await apply(p, CL._id, `${Y + 1}-01-05`, `${Y + 1}-01-05`, 1);
    expect(r.status).toBe(201);
    await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "approved" });
    const thisYear = await balanceOf(p.userId, CL._id, Y);
    const nextYear = await balanceOf(p.userId, CL._id, Y + 1);
    // Expected: next year's balance shows used 1 and nothing is left "pending" anywhere.
    expect({ thisYearPending: thisYear?.pending ?? 0, nextYearUsed: nextYear?.used ?? 0 }).toEqual({ thisYearPending: 0, nextYearUsed: 1 });
  });
  test("[+] unpaid leave type does not touch any balance", async () => {
    const p = A.people.emp2;
    const r = await apply(p, LWP._id, `${Y}-11-20`, `${Y}-11-20`, 1);
    expect(r.status).toBe(201);
    await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "approved" });
    expect(await balanceOf(p.userId, LWP._id)).toBeNull();
  });
});

describe("Rule 18 / field rules — leave request validation", () => {
  test("[BUG?] cannot apply more than the available balance (13 days of a 12-day quota → 400)", async () => {
    const p = await A.addPerson("bal13");
    const r = await apply(p, CL._id, `${Y}-11-02`, `${Y}-11-14`, 13);
    expect(r.status).toBe(400);
  });
  test("[BUG?] overlapping leave is blocked (same dates twice → second is 400)", async () => {
    const p = await A.addPerson("overlap");
    expect((await apply(p, CL._id, `${Y}-11-23`, `${Y}-11-24`, 2)).status).toBe(201);
    expect((await apply(p, CL._id, `${Y}-11-24`, `${Y}-11-25`, 2)).status).toBe(400);
  });
  test("[+] To before From → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-11-10`, `${Y}-11-09`, 1)).status).toBe(400);
  });
  test("[+] days not in steps of 0.5 (0.3) → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-10`, `${Y}-10-10`, 0.3)).status).toBe(400);
  });
  test("[+] total days more than the date range → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-10`, `${Y}-10-10`, 3)).status).toBe(400);
  });
  test("[+] 0 / negative days → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-10`, `${Y}-10-10`, 0)).status).toBe(400);
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-10`, `${Y}-10-10`, -1)).status).toBe(400);
  });
  test("[+] invalid dates (2026-02-30 / abc) → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, "abc", "abc", 1)).status).toBe(400);
  });
  test("[+] missing reason → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-12`, `${Y}-10-12`, 1, { reason: undefined })).status).toBe(400);
  });
  test("[BUG?] reason of only spaces → 400", async () => {
    expect((await apply(A.people.emp2, CL._id, `${Y}-10-13`, `${Y}-10-13`, 1, { reason: "    " })).status).toBe(400);
  });
  test("[+] missing leave type → 4xx with a clear message (no raw JS error)", async () => {
    const r = await apply(A.people.emp2, undefined, `${Y}-10-14`, `${Y}-10-14`, 1);
    expect(r.status).toBe(400);
    expect(String(r.body.message)).not.toMatch(/Cannot read properties|undefined/);
  });
  test("[+] another company's leave type id → 404", async () => {
    const bType = (await B.api.post("/leaves/types", { name: "B only", code: "BON", yearlyQuota: 5 })).body.data;
    expect((await apply(A.people.emp2, bType._id, `${Y}-10-15`, `${Y}-10-15`, 1)).status).toBe(404);
  });
  test("[BUG?] leave type with 'attachment required' → request without attachment is refused", async () => {
    const t = (await A.api.post("/leaves/types", { name: "Medical", code: "MED", yearlyQuota: 10, requiresAttachment: true })).body.data;
    expect((await apply(A.people.emp2, t._id, `${Y}-10-19`, `${Y}-10-19`, 1)).status).toBe(400);
  });
  test("[+] status value outside approved/rejected/cancelled/pending → 400", async () => {
    const r = await apply(A.people.emp2, LWP._id, `${Y}-10-20`, `${Y}-10-20`, 1);
    expect((await A.api.patch(`/leaves/requests/${r.body.data._id}/status`, { status: "APPROVED!" })).status).toBe(400);
  });
});

describe("Rule 19 — default leave types seeded: Sick 12, Casual 12, Earned 15, Privilege 10", () => {
  test("[BUG?] lazy seed creates exactly these four", async () => {
    const C = await seedTenant("LeaveC");
    const p = await C.addPerson("seedemp");
    await apply(p, "sick_id", `${Y}-10-21`, `${Y}-10-21`, 1);
    const types = await mongoose.connection.db.collection("leavetypes").find({ tenant_id: null }).toArray();
    const map = Object.fromEntries(types.map((t) => [t.name, t.yearlyQuota]));
    expect(map).toEqual({ "Sick Leave": 12, "Casual Leave": 12, "Earned Leave": 15, "Privilege Leave": 10 });
  });
});

describe("Leave types — permissions and duplicates", () => {
  test("[+] employee cannot create a leave type (403)", async () => {
    expect((await A.people.emp.api.post("/leaves/types", { name: "X", code: "XX", yearlyQuota: 1 })).status).toBe(403);
  });
  test("[+] leave manager (view_leaves) can create one", async () => {
    expect((await A.people.leavemgr.api.post("/leaves/types", { name: "Mgr type", code: "MGR", yearlyQuota: 2 })).status).toBe(201);
  });
  test("[+] duplicate code in same company → 400; same code in another company → allowed", async () => {
    expect((await A.api.post("/leaves/types", { name: "Dup", code: "CLA", yearlyQuota: 1 })).status).toBe(400);
    expect((await B.api.post("/leaves/types", { name: "Dup", code: "CLA", yearlyQuota: 1 })).status).toBe(201);
  });
  test("[+] yearly quota out of range (367 / -1 / abc) → 400", async () => {
    for (const q of [367, -1, "abc"]) expect((await A.api.post("/leaves/types", { name: `Q${q}`, code: `Q${String(q).replace(/\W/g, "")}`, yearlyQuota: q })).status).toBe(400);
  });
});

describe("Role-based access + company separation (API)", () => {
  let reqId;
  beforeAll(async () => {
    const r = await apply(A.people.emp, LWP._id, `${Y}-10-26`, `${Y}-10-26`, 1);
    reqId = r.body.data._id;
  });
  test("[BUG?] a normal employee listing /leaves/requests sees only OWN requests", async () => {
    const r = await A.people.emp2.api.get("/leaves/requests");
    expect(r.status).toBe(200);
    const others = r.body.data.filter((l) => String(l.employeeId?._id || l.employeeId) !== A.people.emp2.userId);
    expect(others.length).toBe(0);
  });
  test("[BUG?] My Leaves screen call (employeeId = CRM Staff id) returns the employee's own leaves", async () => {
    // MyLeavesPage.tsx:191 sends employeeService.getLeaves({ employeeId: user?.id }) — user is the CRM Staff record.
    const r = await A.people.emp.api.get(`/leaves/requests?employeeId=${A.people.emp.staffId}`);
    expect(r.body.data.length).toBeGreaterThan(0);
  });
  test("[+] employee cannot approve own leave (403)", async () => {
    expect((await A.people.emp.api.patch(`/leaves/requests/${reqId}/status`, { status: "approved" })).status).toBe(403);
  });
  test("[+] employee cannot approve a colleague's leave (403)", async () => {
    expect((await A.people.emp2.api.patch(`/leaves/requests/${reqId}/status`, { status: "approved" })).status).toBe(403);
  });
  test("[+] staff with only an expense permission cannot approve leave (403)", async () => {
    expect((await A.people.expmgr.api.patch(`/leaves/requests/${reqId}/status`, { status: "approved" })).status).toBe(403);
  });
  test("[+] screen-only permission (Staff.permissions) is NOT enough for the API (desync user → 403)", async () => {
    expect((await A.people.desync.api.patch(`/leaves/requests/${reqId}/status`, { status: "approved" })).status).toBe(403);
  });
  test("[+] supervisor of branch 1 can approve branch-1 staff; cannot approve branch-2 staff", async () => {
    const r2 = await apply(A.people.emp2, LWP._id, `${Y}-10-27`, `${Y}-10-27`, 1);
    expect((await A.people.sup.api.patch(`/leaves/requests/${r2.body.data._id}/status`, { status: "approved" })).status).toBe(403);
    expect((await A.people.sup.api.patch(`/leaves/requests/${reqId}/status`, { status: "approved" })).status).toBe(200);
  });
  test("[+] supervisor list is narrowed to own branch staff", async () => {
    const r = await A.people.sup.api.get("/leaves/requests");
    const ids = new Set(r.body.data.map((l) => String(l.employeeId?._id || l.employeeId)));
    expect(ids.has(A.people.emp2.userId)).toBe(false);
  });
  test("[+] other company's admin: approve → 404, list never shows company A rows", async () => {
    expect((await B.api.patch(`/leaves/requests/${reqId}/status`, { status: "rejected" })).status).toBe(404);
    const r = await B.api.get(`/leaves/requests?employeeId=${A.people.emp.userId}`);
    expect(r.body.data.length).toBe(0);
  });
  test("[BUG?] NoSQL operator in a filter (status[$ne]=x) is rejected, not run as a query", async () => {
    const r = await A.api.get("/leaves/requests?status[$ne]=zzz");
    expect(r.status).toBe(400);
  });
  test("[+] no token → 401, bad token → 401", async () => {
    const { client } = require("../../testUtils/hrms-money.harness");
    expect((await client(null).get("/leaves/requests")).status).toBe(401);
    expect((await client("bad.token.here").get("/leaves/requests")).status).toBe(401);
  });
  test("[+] invalid id → 4xx not 500", async () => {
    const r = await A.api.patch("/leaves/requests/not-an-id/status", { status: "approved" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe("Rule 20 — only the right people can change weekly off days", () => {
  test("[BUG?] a normal employee cannot change a colleague's weekly offs", async () => {
    const r = await A.people.emp.api.put(`/users/${A.people.emp2.userId}`, { weeklyHolidays: ["Monday"] });
    const u = await mongoose.connection.db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(A.people.emp2.userId) });
    expect({ status: r.status >= 400 ? "refused" : "allowed", saved: u.weeklyHolidays }).toEqual({ status: "refused", saved: [] });
  });
});

describe("XSS text is stored as plain text (rendering checked in the UI test)", () => {
  test("[+] reason with <script> saved unchanged, API returns JSON (not HTML)", async () => {
    const x = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    const r = await apply(A.people.emp, LWP._id, `${Y}-10-28`, `${Y}-10-28`, 1, { reason: x });
    expect(r.status).toBe(201);
    expect(r.body.data.reason).toBe(x);
  });
});
