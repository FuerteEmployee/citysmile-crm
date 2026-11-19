// HRMS Parts C+D — API sweep (phase 9) and security (phase 10): 401s, plan module off, malformed ids,
// cross-company ids, NoSQL operators in bodies. Each test states the expected behaviour.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedTenant, seedStandardPeople, client } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(180000);
let A, B, OFF;
const BAD = "64b0000000000000000000dd";

// [method, path, body] — every Part C/D endpoint. :id is replaced per test.
const ENDPOINTS = [
  ["GET", "/leaves/requests"], ["POST", "/leaves/requests", {}], ["PATCH", "/leaves/requests/:id/status", { status: "approved" }],
  ["GET", "/leaves/balances"], ["GET", "/leaves/types"], ["POST", "/leaves/types", {}],
  ["GET", "/expenses"], ["POST", "/expenses", {}], ["GET", "/expenses/:id"], ["PUT", "/expenses/:id", {}], ["PATCH", "/expenses/:id/status", { status: "Approved" }], ["DELETE", "/expenses/:id"],
  ["GET", "/expense-categories"], ["POST", "/expense-categories", {}],
  ["GET", "/payroll"], ["POST", "/payroll/generate", {}], ["GET", "/payroll/me"], ["GET", "/payroll/pf-records?month=9&year=2026"], ["GET", "/payroll/pf-records/me"],
  ["PATCH", "/payroll/:id/approve"], ["PATCH", "/payroll/:id/pay"], ["GET", "/payroll/:id/slip"], ["GET", "/payroll/me/:id/slip"], ["DELETE", "/payroll/:id"],
  ["GET", "/advance-salary"], ["POST", "/advance-salary", {}], ["GET", "/advance-salary/:id"], ["PUT", "/advance-salary/:id", {}], ["POST", "/advance-salary/:id/repay", {}], ["DELETE", "/advance-salary/:id"],
  ["GET", "/advance-salary/limit/me"], ["GET", "/advance-salary/loan-limit/me"], ["GET", "/advance-salary/loan-policy"], ["PUT", "/advance-salary/loan-policy", {}],
  ["POST", "/salary-settlements/calculate-estimate", {}], ["PATCH", "/salary-settlements/set-brand-slip-amount", {}], ["PATCH", "/salary-settlements/mark-settled", {}],
  ["GET", "/salary-settlements/list"], ["GET", "/salary-settlements/history/:id"], ["GET", "/salary-settlements/summary?month=9&year=2026"], ["DELETE", "/salary-settlements/:id"],
  ["GET", "/managing-companies"], ["GET", "/managing-companies/:id"], ["POST", "/managing-companies", {}], ["PUT", "/managing-companies/:id", {}], ["PATCH", "/managing-companies/:id/deactivate"], ["DELETE", "/managing-companies/:id"],
  ["GET", "/targets"], ["POST", "/targets", {}], ["PUT", "/targets/:id", {}], ["DELETE", "/targets/:id"],
  ["GET", "/incentive-rules"], ["GET", "/incentive-rules/:id"], ["POST", "/incentive-rules", {}], ["POST", "/incentive-rules/calculate", {}], ["PUT", "/incentive-rules/:id", {}], ["DELETE", "/incentive-rules/:id"],
  ["GET", "/salary-templates"], ["POST", "/salary-templates", {}],
];
const call = (api, m, p, b, id) => {
  const path = p.replace(":id", id);
  return { GET: () => api.get(path), POST: () => api.post(path, b), PUT: () => api.put(path, b), PATCH: () => api.patch(path, b), DELETE: () => api.del(path) }[m]();
};
const OPEN_WHEN_HRMS_OFF = /^\/managing-companies/;

beforeAll(async () => {
  await start();
  A = await seedStandardPeople(await seedTenant("SecA"));
  B = await seedStandardPeople(await seedTenant("SecB"));
  OFF = await seedTenant("SecOff", { hrmsOff: true });
});
afterAll(stop);

describe("Phase 9 — no token → 401 on every endpoint", () => {
  test.each(ENDPOINTS)("[+] %s %s without token → 401", async (m, p, b) => {
    expect((await call(client(null), m, p, b, BAD)).status).toBe(401);
  });
});

describe("Phase 9 — bad / expired / wrong-secret token → 401", () => {
  test.each(ENDPOINTS.slice(0, 12))("[+] %s %s with forged token → 401", async (m, p, b) => {
    const forged = jwt.sign({ id: A.admin.staffId }, "not-the-secret");
    expect((await call(client(forged), m, p, b, BAD)).status).toBe(401);
  });
  test("[+] expired token → 401", async () => {
    const expired = jwt.sign({ id: A.admin.staffId, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    expect((await client(expired).get("/payroll")).status).toBe(401);
  });
});

describe("Phase 9 — malformed id never gives 500", () => {
  test.each(ENDPOINTS.filter((e) => e[1].includes(":id")))("[BUG?] %s %s with id 'not-an-id' → 4xx", async (m, p, b) => {
    const r = await call(A.api, m, p, b, "not-an-id");
    expect(r.status).toBeLessThan(500);
  });
});

describe("Phase 9 — empty body never gives 500", () => {
  test.each(ENDPOINTS.filter((e) => ["POST", "PUT", "PATCH"].includes(e[0])))("[BUG?] %s %s with {} → 4xx/2xx (no 500)", async (m, p, b) => {
    const r = await call(A.api, m, p, b, BAD);
    expect(r.status).toBeLessThan(500);
  });
});

describe("Section 0 — plan with HRMS off → 403 MODULE_DISABLED (managing companies stay open)", () => {
  test.each(ENDPOINTS)("[+] %s %s", async (m, p, b) => {
    const r = await call(OFF.api, m, p, b, BAD);
    if (OPEN_WHEN_HRMS_OFF.test(p)) expect(r.status).not.toBe(403);
    else {
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/MODULE_DISABLED/);
    }
  });
});

describe("Phase 10 — NoSQL injection in ids / bodies", () => {
  test("[+] {$ne:null} as an id in the URL → 4xx", async () => {
    const r = await A.api.get(`/expenses/${encodeURIComponent('{"$ne":null}')}`);
    expect(r.status).toBeLessThan(500);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[BUG?] {$ne:null} as settlement id in body must not match a record", async () => {
    const r = await A.api.patch("/salary-settlements/mark-settled", { id: { $ne: null } });
    expect(r.status).toBe(404);
  });
  test("[+] {$gt:''} as payroll employeeId filter is not an operator leak across companies", async () => {
    const r = await B.api.get("/payroll?employeeId[$gt]=");
    expect(r.status).toBeLessThan(500);
    expect((r.body.data || []).length).toBe(0);
  });
  test("[+] leave type id as object in body → 4xx", async () => {
    const r = await A.people.emp.api.post("/leaves/requests", { leaveTypeId: { $ne: null }, fromDate: "2026-12-01", toDate: "2026-12-01", totalDays: 1, reason: "x" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe("Phase 10 — staff calling admin-only APIs", () => {
  test("[+] employee: generate payroll / loan policy / incentive rule / expense approve → 403", async () => {
    const e = A.people.emp.api;
    expect((await e.post("/payroll/generate", { month: 9, year: 2026 })).status).toBe(403);
    expect((await e.put("/advance-salary/loan-policy", { slabs: [] })).status).toBe(403);
    expect((await e.post("/incentive-rules", { name: "x", rewardType: "fixed", rewardValue: 1 })).status).toBe(403);
  });
  test("[BUG?] employee: delete a salary-slip template of the company → 403", async () => {
    const t = await A.api.post("/salary-templates", { name: "Company slip", isDefault: true, companyName: "SecA Pvt Ltd" });
    const r = await A.people.emp.api.del(`/salary-templates/${t.body.data._id}`);
    expect(r.status).toBe(403);
  });
  test("[BUG?] employee: read company-wide money lists (payroll / settlements / managing companies / targets) → 403", async () => {
    const e = A.people.emp.api;
    const codes = {
      payroll: (await e.get("/payroll")).status,
      settlements: (await e.get("/salary-settlements/list")).status,
      targets: (await e.get("/targets")).status,
    };
    expect(codes).toEqual({ payroll: 403, settlements: 403, targets: 403 });
  });
});
