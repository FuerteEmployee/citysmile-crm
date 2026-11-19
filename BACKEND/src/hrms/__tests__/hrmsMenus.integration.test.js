// HRMS menu-by-menu API tests: [+] positive, [-] negative, [I] integration
// (company isolation / cross-module). Each test states the CORRECT behaviour,
// so a failing test points at a field or rule that does not work properly.
// Runs on an in-memory MongoDB only — see testUtils/hrmsTestApp.js.
const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../testUtils/hrmsTestApp");

jest.setTimeout(120000);

let A; // company A admin
let B; // company B admin (for isolation checks)
let apiA;
let apiB;

beforeAll(async () => {
  await start();
  A = await seedCompany("A");
  B = await seedCompany("B");
  apiA = client(A.token);
  apiB = client(B.token);
});

afterAll(stop);

const oid = () => String(new mongoose.Types.ObjectId());

describe("Shift Management", () => {
  const valid = { name: "General Shift", startTime: "09:00", endTime: "18:00" };

  test("[+] creates a shift with valid HH:mm times", async () => {
    const r = await apiA.post("/shifts", valid);
    expect(r.status).toBe(201);
    expect(r.body.data.lateGraceMinutes).toBe(15);
  });
  test("[-] rejects startTime 25:00", async () => {
    expect((await apiA.post("/shifts", { ...valid, name: "S2", startTime: "25:00" })).status).toBe(400);
  });
  test("[-] rejects missing name", async () => {
    expect((await apiA.post("/shifts", { startTime: "09:00", endTime: "18:00" })).status).toBe(400);
  });
  test("[-] rejects duplicate shift name in same company", async () => {
    expect((await apiA.post("/shifts", valid)).status).toBe(400);
  });
  test("[-] rejects negative lateGraceMinutes", async () => {
    expect((await apiA.post("/shifts", { ...valid, name: "S3", lateGraceMinutes: -10 })).status).toBe(400);
  });
  test("[-] rejects non-numeric overtimeRatePerHour", async () => {
    expect((await apiA.post("/shifts", { ...valid, name: "S4", overtimeRatePerHour: "abc" })).status).toBe(400);
  });
  test("[-] rejects negative overtimeRatePerHour", async () => {
    expect((await apiA.post("/shifts", { ...valid, name: "S5", overtimeRatePerHour: -50 })).status).toBe(400);
  });
  test("[I] company B can use the same shift name as company A", async () => {
    expect((await apiB.post("/shifts", valid)).status).toBe(201);
  });
  test("[I] company B does not see company A's shifts", async () => {
    const r = await apiB.get("/shifts");
    const names = (r.body.data || []).map((s) => String(s.tenant_id));
    expect(names.every((t) => t === String(B.tenantId))).toBe(true);
  });
});

describe("Holiday Calendar", () => {
  test("[+] creates a holiday", async () => {
    const r = await apiA.post("/holidays", { name: "Diwali", date: "2026-11-08", type: "Festival" });
    expect(r.status).toBe(201);
  });
  test("[+] creates a multi-day holiday", async () => {
    const r = await apiA.post("/holidays", { name: "Vacation", date: "2026-12-24", endDate: "2026-12-31" });
    expect(r.status).toBe(201);
  });
  test("[-] rejects missing name", async () => {
    expect((await apiA.post("/holidays", { date: "2026-11-09" })).status).toBe(400);
  });
  test("[-] rejects impossible date 2026-13-45", async () => {
    expect((await apiA.post("/holidays", { name: "Bad", date: "2026-13-45" })).status).toBe(400);
  });
  test("[-] rejects endDate before date", async () => {
    expect((await apiA.post("/holidays", { name: "Back", date: "2026-11-10", endDate: "2026-11-01" })).status).toBe(400);
  });
  test("[-] rejects unknown holiday type", async () => {
    expect((await apiA.post("/holidays", { name: "X", date: "2026-11-11", type: "Party" })).status).toBe(400);
  });
  test("[-] rejects duplicate name on the same date", async () => {
    expect((await apiA.post("/holidays", { name: "Diwali", date: "2026-11-08" })).status).toBe(400);
  });
});

describe("Departments & Designations", () => {
  test("[+] creates a department", async () => {
    expect((await apiA.post("/departments", { name: "Sales", code: "sal" })).status).toBe(201);
  });
  test("[-] department without code is rejected", async () => {
    expect((await apiA.post("/departments", { name: "NoCode" })).status).toBe(400);
  });
  test("[-] duplicate department code (case-insensitive) is rejected", async () => {
    expect((await apiA.post("/departments", { name: "Sales 2", code: "SAL" })).status).toBe(400);
  });
  test("[I] company B can reuse department code SAL", async () => {
    expect((await apiB.post("/departments", { name: "Sales", code: "SAL" })).status).toBe(201);
  });
  test("[+] creates a designation with level 2", async () => {
    expect((await apiA.post("/designations", { name: "Manager", code: "MGR", level: 2 })).status).toBe(201);
  });
  test("[-] designation level 'abc' is rejected", async () => {
    expect((await apiA.post("/designations", { name: "D1", code: "D1", level: "abc" })).status).toBe(400);
  });
  test("[-] designation negative level is rejected", async () => {
    expect((await apiA.post("/designations", { name: "D2", code: "D2", level: -3 })).status).toBe(400);
  });
});

describe("Branch Management", () => {
  const base = { name: "Main Branch", city: "Ahmedabad" };

  test("[+] creates a branch with valid geo-fence", async () => {
    const r = await apiA.post("/hrms-branches", { ...base, latitude: 23.02, longitude: 72.57, radius: 200, geoFenceEnabled: true });
    expect(r.status).toBe(201);
  });
  test("[-] duplicate branch name is rejected", async () => {
    expect((await apiA.post("/hrms-branches", base)).status).toBe(400);
  });
  test("[-] latitude 200 (outside -90..90) is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-lat", latitude: 200, longitude: 72 })).status).toBe(400);
  });
  test("[-] longitude 500 (outside -180..180) is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-lng", latitude: 23, longitude: 500 })).status).toBe(400);
  });
  test("[-] negative geo-fence radius is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-rad", radius: -100 })).status).toBe(400);
  });
  test("[-] pincode '12' (not 6 digits) is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-pin", pincode: "12" })).status).toBe(400);
  });
  test("[-] phone 'abcd' is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-ph", phone: "abcd" })).status).toBe(400);
  });
  test("[-] email 'not-an-email' is rejected", async () => {
    expect((await apiA.post("/hrms-branches", { name: "B-em", email: "not-an-email" })).status).toBe(400);
  });
  test("[+] creates a branch type", async () => {
    expect((await apiA.post("/branch-types", { name: "Retail" })).status).toBe(201);
  });
  test("[-] branch type without name is rejected", async () => {
    expect((await apiA.post("/branch-types", {})).status).toBe(400);
  });
});

describe("Leave Management", () => {
  let leaveTypeId;

  test("[+] creates a leave type", async () => {
    const r = await apiA.post("/leaves/types", { name: "Casual Leave", code: "CL", yearlyQuota: 12 });
    expect(r.status).toBe(201);
    leaveTypeId = r.body.data._id;
  });
  test("[-] leave type with negative yearlyQuota is rejected", async () => {
    expect((await apiA.post("/leaves/types", { name: "Neg", code: "NEG", yearlyQuota: -5 })).status).toBe(400);
  });
  test("[I] company B can create its own leave type with code CL", async () => {
    expect((await apiB.post("/leaves/types", { name: "Casual Leave", code: "CL", yearlyQuota: 10 })).status).toBe(201);
  });
  test("[I] company B does not see company A's leave types", async () => {
    const r = await apiB.get("/leaves/types");
    const ids = (r.body.data || []).map((t) => String(t._id));
    expect(ids).not.toContain(String(leaveTypeId));
  });

  const req = () => ({ leaveTypeId, fromDate: "2026-11-02", toDate: "2026-11-03", totalDays: 2, reason: "Family function" });

  test("[+] applies for a 2-day leave", async () => {
    expect((await apiA.post("/leaves/requests", req())).status).toBe(201);
  });
  test("[-] leave without reason is rejected", async () => {
    expect((await apiA.post("/leaves/requests", { ...req(), reason: undefined })).status).toBe(400);
  });
  test("[-] leave with toDate before fromDate is rejected", async () => {
    expect((await apiA.post("/leaves/requests", { ...req(), fromDate: "2026-11-10", toDate: "2026-11-05" })).status).toBe(400);
  });
  test("[-] leave with negative totalDays is rejected", async () => {
    expect((await apiA.post("/leaves/requests", { ...req(), totalDays: -3 })).status).toBe(400);
  });
  test("[-] leave whose totalDays does not match the date range is rejected", async () => {
    expect((await apiA.post("/leaves/requests", { ...req(), totalDays: 30 })).status).toBe(400);
  });
});

describe("Expense Management", () => {
  const valid = { description: "Client visit fuel", amount: 250.5, category: "Travel", paymentMethod: "UPI" };

  test("[+] creates an expense with decimal amount", async () => {
    const r = await apiA.post("/expenses", valid);
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("Pending");
  });
  test("[+] client cannot force status=Approved on create", async () => {
    const r = await apiA.post("/expenses", { ...valid, status: "Approved" });
    expect(r.body.data.status).toBe("Pending");
  });
  test("[-] amount 0 is rejected", async () => {
    expect((await apiA.post("/expenses", { ...valid, amount: 0 })).status).toBe(400);
  });
  test("[-] negative amount is rejected", async () => {
    expect((await apiA.post("/expenses", { ...valid, amount: -100 })).status).toBe(400);
  });
  test("[-] amount 'abc' is rejected", async () => {
    expect((await apiA.post("/expenses", { ...valid, amount: "abc" })).status).toBe(400);
  });
  test("[-] missing description is rejected", async () => {
    expect((await apiA.post("/expenses", { ...valid, description: undefined })).status).toBe(400);
  });
  test("[-] unknown paymentMethod is rejected", async () => {
    expect((await apiA.post("/expenses", { ...valid, paymentMethod: "Bitcoin" })).status).toBe(400);
  });
  test("[I] company B cannot read company A's expenses", async () => {
    const r = await apiB.get("/expenses");
    const list = r.body.data || r.body.expenses || [];
    expect(list.every((e) => String(e.tenant_id) === String(B.tenantId))).toBe(true);
  });
  test("[+] admin creates an expense category", async () => {
    expect((await apiA.post("/expense-categories", { name: "Travel" })).status).toBe(201);
  });
  test("[I] company B can create its own 'Travel' expense category", async () => {
    expect((await apiB.post("/expense-categories", { name: "Travel" })).status).toBe(201);
  });
});

describe("Advance Salary & Loans", () => {
  // Admin A has fixed salary 30,000.
  test("[+] requests a small advance within the limit", async () => {
    const r = await apiA.post("/advance-salary", { amount: 1000, reason: "Medical" });
    expect(r.status).toBe(201);
  });
  test("[-] advance above the salary cap is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: 999999, reason: "Too big" })).status).toBe(400);
  });
  test("[-] negative advance amount is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: -500, reason: "Negative" })).status).toBe(400);
  });
  test("[-] zero advance amount is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: 0, reason: "Zero" })).status).toBe(400);
  });
  test("[-] advance amount 'abc' is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: "abc", reason: "Text" })).status).toBe(400);
  });
  test("[-] advance without reason is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: 100 })).status).toBe(400);
  });
  test("[-] negative monthlyInstallmentAmount is rejected", async () => {
    expect((await apiA.post("/advance-salary", { amount: 100, reason: "EMI", monthlyInstallmentAmount: -50 })).status).toBe(400);
  });

  describe("repayments", () => {
    let id;
    beforeAll(async () => {
      const AdvanceSalary = require("../models/advance_salary_model");
      const rec = await AdvanceSalary.create({
        employeeId: A.userId, type: "Advance Salary", amount: 2000, remainingAmount: 2000,
        reason: "seed", status: "Approved", tenant_id: A.tenantId,
      });
      id = String(rec._id);
    });
    test("[-] repayment of 0 is rejected", async () => {
      expect((await apiA.post(`/advance-salary/${id}/repay`, { amount: 0 })).status).toBe(400);
    });
    test("[-] repayment above outstanding is rejected", async () => {
      expect((await apiA.post(`/advance-salary/${id}/repay`, { amount: 5000 })).status).toBe(400);
    });
    test("[+] partial repayment reduces the balance", async () => {
      const r = await apiA.post(`/advance-salary/${id}/repay`, { amount: 500 });
      expect(r.status).toBe(200);
      expect(r.body.data.remainingAmount).toBe(1500);
    });
    test("[+] full repayment closes the advance", async () => {
      const r = await apiA.post(`/advance-salary/${id}/repay`, { amount: 1500 });
      expect(r.body.data.status).toBe("Repaid");
    });
    test("[I] company B cannot repay company A's advance", async () => {
      expect((await apiB.post(`/advance-salary/${id}/repay`, { amount: 1 })).status).toBe(404);
    });
  });
});

describe("Incentive Slabs", () => {
  const slabRule = (slabs, extra = {}) => ({ name: `Rule ${Math.random()}`, rewardType: "slab", slabs, ...extra });

  test("[+] creates contiguous slabs 0-80, 80-100, 100+", async () => {
    const r = await apiA.post("/incentive-rules", slabRule([
      { minPct: 0, maxPct: 80, type: "percentage", value: 0 },
      { minPct: 80, maxPct: 100, type: "percentage", value: 2 },
      { minPct: 100, maxPct: null, type: "percentage", value: 5 },
    ]));
    expect(r.status).toBe(201);
  });
  test("[-] overlapping slabs are rejected", async () => {
    const r = await apiA.post("/incentive-rules", slabRule([{ minPct: 0, maxPct: 90, value: 1 }, { minPct: 80, maxPct: null, value: 2 }]));
    expect(r.status).toBe(400);
  });
  test("[-] gap between slabs is rejected", async () => {
    const r = await apiA.post("/incentive-rules", slabRule([{ minPct: 0, maxPct: 50, value: 1 }, { minPct: 60, maxPct: null, value: 2 }]));
    expect(r.status).toBe(400);
  });
  test("[-] slab with no slabs is rejected", async () => {
    expect((await apiA.post("/incentive-rules", slabRule([]))).status).toBe(400);
  });
  test("[-] slab with negative reward value is rejected", async () => {
    const r = await apiA.post("/incentive-rules", slabRule([{ minPct: 0, maxPct: null, type: "percentage", value: -5 }]));
    expect(r.status).toBe(400);
  });
  test("[-] percentage reward above 100 is rejected", async () => {
    const r = await apiA.post("/incentive-rules", slabRule([{ minPct: 0, maxPct: null, type: "percentage", value: 150 }]));
    expect(r.status).toBe(400);
  });
  test("[-] rule without name is rejected", async () => {
    expect((await apiA.post("/incentive-rules", { rewardType: "fixed", rewardValue: 100 })).status).toBe(400);
  });
  test("[-] fixed reward with negative rewardValue is rejected", async () => {
    expect((await apiA.post("/incentive-rules", { name: "Neg fixed", rewardType: "fixed", rewardValue: -100 })).status).toBe(400);
  });
});

describe("Staff Directory (create employee)", () => {
  let n = 0;
  const staff = (extra = {}) => {
    n += 1;
    return { name: `Test Emp ${n}`, email: `emp${n}@hrms-test.local`, mobile: `98765432${String(n).padStart(2, "0")}`, password: "Test@1234", ...extra };
  };

  test("[+] creates an employee with 10-digit mobile", async () => {
    const r = await apiA.post("/users", staff());
    expect(r.status).toBe(201);
  });
  test("[-] 9-digit mobile is rejected", async () => {
    expect((await apiA.post("/users", staff({ mobile: "987654321" }))).status).toBe(400);
  });
  test("[-] mobile with letters is rejected", async () => {
    expect((await apiA.post("/users", staff({ mobile: "98765abcde" }))).status).toBe(400);
  });
  test("[-] missing mobile is rejected", async () => {
    expect((await apiA.post("/users", staff({ mobile: "" }))).status).toBe(400);
  });
  test("[-] invalid email is rejected", async () => {
    expect((await apiA.post("/users", staff({ email: "not-an-email" }))).status).toBe(400);
  });
  test("[-] missing name is rejected", async () => {
    expect((await apiA.post("/users", staff({ name: "" }))).status).toBe(400);
  });
  test("[-] duplicate email in same company is rejected", async () => {
    const s = staff();
    await apiA.post("/users", s);
    expect((await apiA.post("/users", { ...s, mobile: "9123456780" })).status).toBeGreaterThanOrEqual(400);
  });
  test("[-] negative base salary is rejected", async () => {
    expect((await apiA.post("/users", staff({ salaryAmount: -5000 }))).status).toBe(400);
  });
  test("[-] negative basic in salary breakdown is rejected", async () => {
    const r = await apiA.post("/users", staff({ salaryConfig: { basic: { value: -5000 }, hra: { value: 1000 } } }));
    expect(r.status).toBe(400);
  });
  test("[-] non-numeric HRA in salary breakdown is rejected (not silently 0)", async () => {
    const r = await apiA.post("/users", staff({ salaryConfig: { basic: { value: 10000 }, hra: { value: "abc" } } }));
    expect(r.status).toBe(400);
  });
  test("[I] company B does not see company A's employees", async () => {
    const r = await apiB.get("/users");
    const list = r.body.data || r.body.users || [];
    expect(list.every((u) => String(u.tenant_id) === String(B.tenantId))).toBe(true);
  });
  test("[I] company B cannot open company A's employee by id", async () => {
    const r = await apiB.get(`/users/${A.userId}`);
    expect([403, 404]).toContain(r.status);
  });
});

describe("Salary Management / Settlements / PF", () => {
  test("[+] payroll list loads", async () => {
    expect((await apiA.get("/payroll")).status).toBe(200);
  });
  test("[+] PF records load", async () => {
    expect((await apiA.get("/payroll/pf-records?month=10&year=2026")).status).toBe(200);
  });
  test("[-] PF records without month/year is rejected", async () => {
    expect((await apiA.get("/payroll/pf-records")).status).toBe(400);
  });
  test("[-] generate payroll without month/year is rejected", async () => {
    expect((await apiA.post("/payroll/generate", {})).status).toBe(400);
  });
  test("[-] generate payroll for month 13 is rejected", async () => {
    expect((await apiA.post("/payroll/generate", { month: 13, year: 2026 })).status).toBe(400);
  });
  test("[-] generate payroll for year 'abcd' is rejected", async () => {
    expect((await apiA.post("/payroll/generate", { month: 1, year: "abcd" })).status).toBe(400);
  });
  test("[-] settlement estimate without employee is rejected", async () => {
    expect((await apiA.post("/salary-settlements/calculate-estimate", { month: 1, year: 2026 })).status).toBe(400);
  });
  test("[-] settlement estimate for unknown employee is 404", async () => {
    expect((await apiA.post("/salary-settlements/calculate-estimate", { employeeId: oid(), month: 1, year: 2026 })).status).toBe(404);
  });
  test("[I] company B cannot get a settlement estimate for company A's employee", async () => {
    const r = await apiB.post("/salary-settlements/calculate-estimate", { employeeId: String(A.userId), month: 1, year: 2026 });
    expect([403, 404]).toContain(r.status);
  });
});

describe("Security basics (all menus)", () => {
  test("[-] request without token is 401", async () => {
    expect((await client("").get("/shifts")).status).toBe(401);
  });
  test("[-] request with forged token is 401", async () => {
    expect((await client("forged.token.value").get("/users")).status).toBe(401);
  });
});
