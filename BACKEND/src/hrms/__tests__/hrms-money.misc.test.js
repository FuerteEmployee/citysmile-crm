// HRMS Part D — Salary Settlements, Managing Companies, Targets, Incentive Slabs (rules 37-40, suspected 30-32).
const mongoose = require("mongoose");
const { start, stop, seedTenant, seedStandardPeople } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(120000);
let A, B, db;

beforeAll(async () => {
  await start();
  db = mongoose.connection.db;
  A = await seedStandardPeople(await seedTenant("MiscA"));
  B = await seedStandardPeople(await seedTenant("MiscB"));
});
afterAll(stop);

describe("Managing Companies (needs manage_settings)", () => {
  let mc;
  test("[+] admin creates; duplicate (any case) → 409; other company may reuse the name", async () => {
    const r = await A.api.post("/managing-companies", { name: "Gujarat Electronics" });
    expect(r.status).toBe(201);
    mc = r.body.data;
    expect((await A.api.post("/managing-companies", { name: "gujarat electronics" })).status).toBe(409);
    expect((await B.api.post("/managing-companies", { name: "Gujarat Electronics" })).status).toBe(201);
  });
  test("[BUG?] normal employee cannot create / edit / deactivate / delete managing companies (403)", async () => {
    const e = A.people.emp.api;
    const res = [
      (await e.post("/managing-companies", { name: "Emp Co" })).status,
      (await e.put(`/managing-companies/${mc._id}`, { name: "Renamed by emp" })).status,
      (await e.patch(`/managing-companies/${mc._id}/deactivate`)).status,
    ];
    expect(res).toEqual([403, 403, 403]);
  });
  test("[+] empty / spaces-only name → 400", async () => {
    expect((await A.api.post("/managing-companies", { name: "" })).status).toBe(400);
    expect((await A.api.post("/managing-companies", { name: "   " })).status).toBe(400);
  });
  test("[BUG?] regex characters in the name are treated as text ('.*' must not count as a duplicate of everything)", async () => {
    const r = await A.api.post("/managing-companies", { name: ".*" });
    expect(r.status).toBe(201);
  });
  test("[BUG?] a name with '(' is accepted as text (no regex crash)", async () => {
    const r = await A.api.post("/managing-companies", { name: "Shah (Pvt" });
    expect(r.status).toBe(201);
  });
  test("[BUG?] very long name (10,000 chars) refused", async () => {
    expect((await A.api.post("/managing-companies", { name: "a".repeat(10000) })).status).toBe(400);
  });
  test("[+] other company: get/edit/delete → 404", async () => {
    const id = (await A.api.post("/managing-companies", { name: "Private A" })).body.data._id;
    expect((await B.api.get(`/managing-companies/${id}`)).status).toBe(404);
    expect((await B.api.put(`/managing-companies/${id}`, { name: "x" })).status).toBe(404);
    expect((await B.api.del(`/managing-companies/${id}`)).status).toBe(404);
  });
  test("[+] referenced company cannot be deleted (409); unreferenced can", async () => {
    const id = (await A.api.post("/managing-companies", { name: "Ref Co" })).body.data._id;
    await db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(A.people.emp.userId) }, { $set: { managingCompanyId: new mongoose.Types.ObjectId(id) } });
    expect((await A.api.del(`/managing-companies/${id}`)).status).toBe(409);
    const id2 = (await A.api.post("/managing-companies", { name: "Free Co" })).body.data._id;
    expect((await A.api.del(`/managing-companies/${id2}`)).status).toBe(200);
  });
  test("[+] plan with HRMS off still allows managing companies (listed exception)", async () => {
    const C = await seedTenant("MiscOff", { hrmsOff: true });
    expect((await C.api.get("/managing-companies")).status).toBe(200);
    expect((await C.api.get("/payroll")).status).toBe(403);
  });
});

describe("Rule 37 — Salary Settlements", () => {
  test("[BUG?] estimate = decided × achieved ÷ target when a target exists (settlements must not always be 'no target set')", async () => {
    const r = await A.api.post("/salary-settlements/calculate-estimate", { employeeId: A.people.emp.userId, month: 9, year: 2026 });
    expect(r.status).toBe(200);
    expect(r.body.data.flags.noTargetSet).toBe(false);
  });
  let sid;
  test("[+] brand slip → variance = brand slip − decided (32,500 − 30,000 = +2,500, employee → company)", async () => {
    const list = await A.api.get("/salary-settlements/list?month=9&year=2026");
    sid = list.body.data[0]._id;
    const r = await A.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: 32500 });
    expect(r.body.data).toMatchObject({ variance: 2500, settlementAmount: 2500, direction: "employee_to_ge", status: "pending_settlement" });
    const r2 = await A.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: 27999.6 });
    expect(r2.body.data).toMatchObject({ variance: -2000, direction: "ge_to_employee" });
  });
  test("[+] brand slip negative / text → 400", async () => {
    expect((await A.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: -1 })).status).toBe(400);
    expect((await A.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: "100" })).status).toBe(400);
  });
  test("[+] settled record is locked (brand slip 409, recalculate 409, mark again 409, delete needs force)", async () => {
    expect((await A.api.patch("/salary-settlements/mark-settled", { id: sid })).status).toBe(200);
    expect((await A.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: 1 })).status).toBe(409);
    expect((await A.api.post("/salary-settlements/calculate-estimate", { employeeId: A.people.emp.userId, month: 9, year: 2026 })).status).toBe(409);
    expect((await A.api.patch("/salary-settlements/mark-settled", { id: sid })).status).toBe(409);
    expect((await A.api.del(`/salary-settlements/${sid}`)).status).toBe(409);
  });
  test("[+] summary totals settled amounts", async () => {
    const r = await A.api.get("/salary-settlements/summary?month=9&year=2026");
    expect(r.body.data).toMatchObject({ totalGEToEmployee: 2000, net: -2000 });
  });
  test("[+] employee cannot calculate / set slip / settle (403)", async () => {
    expect((await A.people.emp.api.post("/salary-settlements/calculate-estimate", { employeeId: A.people.emp.userId, month: 9, year: 2026 })).status).toBe(403);
    expect((await A.people.emp.api.patch("/salary-settlements/mark-settled", { id: sid })).status).toBe(403);
  });
  test("[BUG?] normal employee cannot read the settlement list / summary / a colleague's history (403)", async () => {
    const e = A.people.emp2.api;
    expect([(await e.get("/salary-settlements/list")).status, (await e.get("/salary-settlements/summary?month=9&year=2026")).status, (await e.get(`/salary-settlements/history/${A.people.emp.userId}`)).status]).toEqual([403, 403, 403]);
  });
  test("[+] other company: list empty, slip → 404, cannot estimate for A's employee (404)", async () => {
    expect((await B.api.get("/salary-settlements/list")).body.data.length).toBe(0);
    expect((await B.api.patch("/salary-settlements/set-brand-slip-amount", { id: sid, brandSlipAmount: 1 })).status).toBe(404);
    expect((await B.api.post("/salary-settlements/calculate-estimate", { employeeId: A.people.emp.userId, month: 9, year: 2026 })).status).toBe(404);
  });
  test("[+] employee without salary / managing company → 400 with message", async () => {
    expect((await A.api.post("/salary-settlements/calculate-estimate", { employeeId: A.people.emp2.userId, month: 9, year: 2026 })).status).toBe(400);
    expect((await A.api.post("/salary-settlements/calculate-estimate", {})).status).toBe(400);
  });
});

describe("Targets (rules 38, 39)", () => {
  test("[BUG?] opening Targets (GET) does NOT create demo/random data", async () => {
    const C = await seedStandardPeople(await seedTenant("TgtC"));
    const before = await db.collection("targetprofiles").countDocuments({ tenant_id: C.tenantId });
    await C.api.get("/targets");
    const after = await db.collection("targetprofiles").countDocuments({ tenant_id: C.tenantId });
    const earnings = await db.collection("incentiveearnings").countDocuments({});
    expect({ before, after, earningsCreated: earnings > 0 }).toEqual({ before: 0, after: 0, earningsCreated: false });
  });
  test.each([
    [79999, "0.0%", 0], [80000, "0.5%", 400], [99999, "0.5%", 500], [100000, "1.0%", 1000], [119999, "1.0%", 1200], [120000, "1.5%", 1800], [150000, "1.5%", 2250],
  ])("[+] target 1,00,000 achieved %d → rate %s, incentive ₹%d", async (ach, rate, amt) => {
    const p = await A.addPerson(`t${ach}`);
    const r = await A.api.post("/targets", { employeeId: p.userId, month: 9, year: 2026, revenueTarget: 100000, marginTargetPercent: 10, achievedRevenue: ach, achievedMargin: 10 });
    expect(r.status).toBe(201);
    expect({ rate: r.body.data.incentive, amt: r.body.data.incentiveAmount }).toEqual({ rate, amt });
  });
  test("[BUG?] normal employee cannot create / edit / delete targets (403)", async () => {
    const e = A.people.emp.api;
    expect((await e.post("/targets", { employeeId: A.people.emp.userId, month: 10, year: 2026, revenueTarget: 1, achievedRevenue: 999999 })).status).toBe(403);
  });
  test("[BUG?] cannot create a target for ANOTHER company's employee", async () => {
    const r = await A.api.post("/targets", { employeeId: B.people.emp.userId, month: 9, year: 2026, revenueTarget: 1000 });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[BUG?] negative revenue target / month 13 refused", async () => {
    const p = await A.addPerson("tneg");
    expect((await A.api.post("/targets", { employeeId: p.userId, month: 13, year: 2026, revenueTarget: -5 })).status).toBe(400);
  });
  test("[+] other company cannot edit/delete A's target (404)", async () => {
    const p = await A.addPerson("tsep");
    const id = (await A.api.post("/targets", { employeeId: p.userId, month: 9, year: 2026, revenueTarget: 1000 })).body.data._id;
    expect((await B.api.put(`/targets/${id}`, { revenueTarget: 1 })).status).toBe(404);
    expect((await B.api.del(`/targets/${id}`)).status).toBe(404);
  });
  test("[+] hidden feature: tenant with hidden 'targets' — API still answers (screen-only hiding, report)", async () => {
    const H = await seedTenant("TgtHidden", { hidden: ["targets", "incentive_slabs"] });
    const r = await H.api.get("/targets");
    expect(r.status).toBe(200);
  });
});

describe("Incentive Slabs (field rule + rule 40)", () => {
  const rule = (slabs, extra = {}) => A.api.post("/incentive-rules", { name: `R${Math.random()}`, rewardType: "slab", slabs, ...extra });
  test("[+] contiguous ladder with one open-ended top slab → 201", async () => {
    expect((await rule([{ minPct: 0, maxPct: 80, value: 0 }, { minPct: 80, maxPct: 100, value: 1 }, { minPct: 100, maxPct: null, value: 2 }])).status).toBe(201);
  });
  test("[+] gap (0-50, 60-∞) → 400; overlap (0-60, 50-∞) → 400; two open-ended → 400; % > 100 → 400", async () => {
    expect((await rule([{ minPct: 0, maxPct: 50, value: 1 }, { minPct: 60, maxPct: null, value: 2 }])).status).toBe(400);
    expect((await rule([{ minPct: 0, maxPct: 60, value: 1 }, { minPct: 50, maxPct: null, value: 2 }])).status).toBe(400);
    expect((await rule([{ minPct: 0, maxPct: null, value: 1 }, { minPct: 50, maxPct: null, value: 2 }])).status).toBe(400);
    expect((await rule([{ minPct: 0, maxPct: null, value: 101 }])).status).toBe(400);
  });
  test("[BUG?] ladder with NO open-ended highest slab (0-50, 50-100) → 400", async () => {
    expect((await rule([{ minPct: 0, maxPct: 50, value: 1 }, { minPct: 50, maxPct: 100, value: 2 }])).status).toBe(400);
  });
  test("[BUG?] rule 40 — conditions applied: min revenue ₹2,00,000 not met → incentive 0", async () => {
    const r = await rule([{ minPct: 0, maxPct: null, value: 2 }], { conditions: { minRevenue: 200000, minMarginPercent: 0 } });
    const c = await A.api.post("/incentive-rules/calculate", { ruleId: r.body.data._id, achievedAmount: 150000, targetAmount: 100000 });
    expect(c.body.data.incentiveAmount).toBe(0);
  });
  test("[+] calculate: 150% of target, 2% slab → ₹3,000 on ₹1,50,000", async () => {
    const r = await rule([{ minPct: 0, maxPct: 100, value: 1 }, { minPct: 100, maxPct: null, value: 2 }]);
    const c = await A.api.post("/incentive-rules/calculate", { ruleId: r.body.data._id, achievedAmount: 150000, targetAmount: 100000 });
    expect(c.body.data).toMatchObject({ achievementPct: 150, incentiveAmount: 3000 });
  });
  test("[+] employee cannot create/edit/delete rules (403)", async () => {
    expect((await A.people.emp.api.post("/incentive-rules", { name: "x", rewardType: "fixed", rewardValue: 1 })).status).toBe(403);
  });
  test("[+] other company: get/update/delete → 404; calculate with A's rule → 404", async () => {
    const r = await rule([{ minPct: 0, maxPct: null, value: 1 }]);
    expect((await B.api.get(`/incentive-rules/${r.body.data._id}`)).status).toBe(404);
    expect((await B.api.put(`/incentive-rules/${r.body.data._id}`, { name: "x" })).status).toBe(404);
    expect((await B.api.post("/incentive-rules/calculate", { ruleId: r.body.data._id, achievedAmount: 1, targetAmount: 1 })).status).toBe(404);
  });
  test("[+] negative reward / min margin 150 → 400", async () => {
    expect((await A.api.post("/incentive-rules", { name: "neg", rewardType: "fixed", rewardValue: -1 })).status).toBe(400);
    expect((await A.api.post("/incentive-rules", { name: "mm", rewardType: "fixed", rewardValue: 1, conditions: { minMarginPercent: 150 } })).status).toBe(400);
  });
});
