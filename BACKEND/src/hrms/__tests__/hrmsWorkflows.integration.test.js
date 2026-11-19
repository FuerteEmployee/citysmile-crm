// HRMS workflow tests: permissions, device approvals, session logs, live tracking,
// attendance, loans, payroll calculation, approvals and edit/delete. [+] positive,
// [-] negative, [I] integration, [C] calculation. In-memory MongoDB only.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedCompany, client } = require("../testUtils/hrmsTestApp");

jest.setTimeout(120000);

let A;
let B;
let apiA;
let apiB;
let emp; // { userId, staffId, api } — a normal (non-admin) employee of company A
const PASSWORD = "Test@1234";

async function createEmployee(api, n, extra = {}) {
  const email = `wf.emp${n}@hrms-test.local`;
  const r = await api.post("/users", { name: `Wf Emp ${n}`, email, mobile: `97000000${String(n).padStart(2, "0")}`, password: PASSWORD, salaryAmount: 30000, ...extra });
  if (r.status !== 201) throw new Error(`createEmployee ${r.status} ${JSON.stringify(r.body)}`);
  const Staff = require("../../models/Staff");
  const userId = String(r.body.data?._id || r.body._id || r.body.user?._id);
  const staff = await Staff.findOne({ email });
  const token = jwt.sign({ id: String(staff._id) }, process.env.JWT_SECRET);
  return { userId, staffId: String(staff._id), email, api: client(token) };
}

beforeAll(async () => {
  await start();
  A = await seedCompany("A");
  B = await seedCompany("B");
  apiA = client(A.token);
  apiB = client(B.token);
  emp = await createEmployee(apiA, 1);
});

afterAll(stop);

describe("Permissions: a normal employee cannot do admin work", () => {
  test("[-] employee cannot create a holiday", async () => {
    expect((await emp.api.post("/holidays", { name: "Self holiday", date: "2026-11-20" })).status).toBe(403);
  });
  test("[-] employee cannot create an incentive rule", async () => {
    expect((await emp.api.post("/incentive-rules", { name: "Self", rewardType: "fixed", rewardValue: 1 })).status).toBe(403);
  });
  test("[-] employee cannot create a shift", async () => {
    expect((await emp.api.post("/shifts", { name: "Emp shift", startTime: "09:00", endTime: "10:00" })).status).toBe(403);
  });
  test("[-] employee cannot create a department", async () => {
    expect((await emp.api.post("/departments", { name: "Emp dept", code: "EMPD" })).status).toBe(403);
  });
  test("[-] employee cannot create a branch", async () => {
    expect((await emp.api.post("/hrms-branches", { name: "Emp branch" })).status).toBe(403);
  });
  test("[-] employee cannot generate payroll", async () => {
    expect((await emp.api.post("/payroll/generate", { month: 9, year: 2026 })).status).toBe(403);
  });
  test("[-] employee cannot correct their own attendance", async () => {
    const r = await emp.api.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-01", statusOverride: "Full Day" });
    expect(r.status).toBe(403);
  });
  test("[-] employee cannot create a leave type", async () => {
    expect((await emp.api.post("/leaves/types", { name: "Emp leave", code: "EMPL", yearlyQuota: 365 })).status).toBe(403);
  });
  test("[-] employee cannot change the loan policy", async () => {
    expect((await emp.api.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxLoan: 9999999 }] })).status).toBe(403);
  });
  test("[-] employee cannot approve their own expense", async () => {
    const e = await emp.api.post("/expenses", { description: "Own", amount: 100, category: "Travel" });
    const id = e.body.data._id;
    expect((await emp.api.patch(`/expenses/${id}/status`, { status: "Approved" })).status).toBe(403);
  });
  test("[-] employee cannot approve their own leave", async () => {
    const t = await apiA.post("/leaves/types", { name: "Perm Leave", code: "PERM", yearlyQuota: 5 });
    const l = await emp.api.post("/leaves/requests", { leaveTypeId: t.body.data._id, fromDate: "2026-12-01", toDate: "2026-12-01", totalDays: 1, reason: "x" });
    expect((await emp.api.patch(`/leaves/requests/${l.body.data._id}/status`, { status: "approved" })).status).toBe(403);
  });
  test("[-] employee cannot approve their own advance", async () => {
    const a = await emp.api.post("/advance-salary", { amount: 100, reason: "self" });
    expect((await emp.api.put(`/advance-salary/${a.body.data._id}`, { status: "Approved" })).status).toBe(403);
  });
  test("[-] employee cannot read another employee's salary details", async () => {
    const r = await emp.api.get(`/users/${A.userId}`);
    const d = r.body?.data || {};
    expect(r.status === 403 || (d.bankInfo === undefined && d.legalDocuments === undefined && d.salaryAmount === undefined)).toBe(true);
  });
});

describe("Approvals (admin)", () => {
  test("[+] admin approves an expense", async () => {
    const e = await emp.api.post("/expenses", { description: "Taxi", amount: 300, category: "Travel" });
    const r = await apiA.patch(`/expenses/${e.body.data._id}/status`, { status: "Approved" });
    expect(r.status).toBe(200);
    expect((r.body.data || r.body).status).toBe("Approved");
  });
  test("[-] expense status 'Banana' is rejected", async () => {
    const e = await emp.api.post("/expenses", { description: "Bus", amount: 50, category: "Travel" });
    expect((await apiA.patch(`/expenses/${e.body.data._id}/status`, { status: "Banana" })).status).toBe(400);
  });
  test("[I] company B cannot approve company A's expense", async () => {
    const e = await emp.api.post("/expenses", { description: "Auto", amount: 70, category: "Travel" });
    expect([403, 404]).toContain((await apiB.patch(`/expenses/${e.body.data._id}/status`, { status: "Approved" })).status);
  });
  test("[C] approving a 2-day leave moves 2 days from pending to used", async () => {
    const t = await apiA.post("/leaves/types", { name: "Calc Leave", code: "CALC", yearlyQuota: 10, isPaid: true });
    const l = await emp.api.post("/leaves/requests", { leaveTypeId: t.body.data._id, fromDate: "2026-12-07", toDate: "2026-12-08", totalDays: 2, reason: "calc" });
    const r = await apiA.patch(`/leaves/requests/${l.body.data._id}/status`, { status: "approved" });
    expect(r.status).toBe(200);
    const LeaveBalance = require("../models/leave_balance_model");
    const bal = await LeaveBalance.findOne({ employeeId: emp.userId, leaveTypeId: t.body.data._id });
    expect(bal.used).toBe(2);
    expect(bal.pending).toBe(0);
  });
  test("[-] approving the same leave twice does not count it twice", async () => {
    const t = await apiA.post("/leaves/types", { name: "Twice Leave", code: "TWC", yearlyQuota: 10, isPaid: true });
    const l = await emp.api.post("/leaves/requests", { leaveTypeId: t.body.data._id, fromDate: "2026-12-14", toDate: "2026-12-14", totalDays: 1, reason: "twice" });
    await apiA.patch(`/leaves/requests/${l.body.data._id}/status`, { status: "approved" });
    await apiA.patch(`/leaves/requests/${l.body.data._id}/status`, { status: "approved" });
    const LeaveBalance = require("../models/leave_balance_model");
    const bal = await LeaveBalance.findOne({ employeeId: emp.userId, leaveTypeId: t.body.data._id });
    expect(bal.used).toBe(1);
  });
});

describe("Device Approvals & Session Logs", () => {
  let dev;
  beforeAll(async () => {
    dev = await createEmployee(apiA, 2);
  });
  const login = (deviceId, email = dev.email) => client("").post("/users/login", { email, password: PASSWORD, deviceId });

  test("[+] first login registers the device", async () => {
    expect((await login("phone-1")).status).toBe(200);
  });
  test("[+] same device logs in again", async () => {
    expect((await login("phone-1")).status).toBe(200);
  });
  test("[-] a new device is blocked and a request is raised", async () => {
    expect((await login("phone-2")).status).toBe(403);
  });
  test("[-] wrong password is rejected", async () => {
    const r = await client("").post("/users/login", { email: dev.email, password: "wrong", deviceId: "phone-1" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[+] admin sees the pending device request and approves it", async () => {
    const list = await apiA.get("/users/device-approvals");
    expect(list.status).toBe(200);
    const rows = list.body.data || list.body;
    const reqRow = rows.find((d) => d.requestedDeviceId === "phone-2");
    expect(reqRow).toBeDefined();
    expect((await apiA.patch(`/users/device-approvals/${reqRow._id}/approve`)).status).toBe(200);
    expect((await login("phone-2")).status).toBe(200);
  });
  test("[I] company B does not see company A's device requests", async () => {
    await login("phone-3");
    const list = await apiB.get("/users/device-approvals");
    const rows = list.body.data || list.body || [];
    expect(rows.some((d) => d.requestedDeviceId === "phone-3")).toBe(false);
  });
  test("[I] company B cannot approve company A's device request", async () => {
    const rows = (await apiA.get("/users/device-approvals")).body.data;
    const row = rows.find((d) => d.requestedDeviceId === "phone-3");
    expect([403, 404]).toContain((await apiB.patch(`/users/device-approvals/${row._id}/approve`)).status);
  });
  test("[+] session logs record the logins", async () => {
    const r = await apiA.get("/users/session-logs");
    expect(r.status).toBe(200);
    const rows = r.body.data || r.body.logs || r.body;
    expect(rows.some((s) => String(s.userId?._id || s.userId) === dev.userId)).toBe(true);
  });
  test("[I] company B does not see company A's session logs", async () => {
    const r = await apiB.get("/users/session-logs");
    const rows = r.body.data || r.body.logs || r.body || [];
    expect(rows.some((s) => String(s.userId?._id || s.userId) === dev.userId)).toBe(false);
  });
  test("[-] employee cannot open the device approvals list", async () => {
    expect((await emp.api.get("/users/device-approvals")).status).toBe(403);
  });
});

describe("Live Tracking", () => {
  test("[+] employee sends a valid location", async () => {
    const r = await emp.api.post("/locations/update", { lat: 23.0225, lng: 72.5714, address: "Ahmedabad" });
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
  });
  test("[-] missing coordinates are rejected", async () => {
    expect((await emp.api.post("/locations/update", {})).status).toBe(400);
  });
  test("[-] latitude 200 is rejected", async () => {
    expect((await emp.api.post("/locations/update", { lat: 200, lng: 72, address: "x" })).status).toBe(400);
  });
  test("[-] text coordinates are rejected with 400 (not a crash)", async () => {
    expect((await emp.api.post("/locations/update", { lat: "abc", lng: "xyz" })).status).toBe(400);
  });
  test("[+] admin sees the employee on the live map", async () => {
    const r = await apiA.get("/locations/latest");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(emp.userId);
  });
  test("[I] company B does not see company A's employees on the map", async () => {
    const r = await apiB.get("/locations/latest");
    expect(JSON.stringify(r.body)).not.toContain(emp.userId);
  });
});

describe("Attendance Dashboard (admin correction)", () => {
  test("[+] admin marks a Full Day", async () => {
    const r = await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-02", punchInTime: "09:00", punchOutTime: "18:00" });
    expect(r.status).toBe(200);
  });
  test("[-] punch-out before punch-in is rejected", async () => {
    expect((await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-03", punchInTime: "18:00", punchOutTime: "09:00" })).status).toBe(400);
  });
  test("[-] time 25:00 is rejected", async () => {
    expect((await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-03", punchInTime: "25:00" })).status).toBe(400);
  });
  test("[-] lunch outside the shift is rejected", async () => {
    const r = await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-03", punchInTime: "09:00", punchOutTime: "18:00", lunchInTime: "19:00", lunchOutTime: "19:30" });
    expect(r.status).toBe(400);
  });
  test("[-] status 'Holiday' is rejected", async () => {
    expect((await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-03", statusOverride: "Holiday" })).status).toBe(400);
  });
  test("[-] impossible date 2026-13-45 is rejected", async () => {
    expect((await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-13-45", statusOverride: "Full Day" })).status).toBe(400);
  });
  test("[-] future date is rejected", async () => {
    expect((await apiA.patch("/attendance/admin-correct", { userId: emp.userId, date: "2099-01-01", statusOverride: "Full Day" })).status).toBe(400);
  });
  test("[I] company B cannot correct company A's employee", async () => {
    const r = await apiB.patch("/attendance/admin-correct", { userId: emp.userId, date: "2026-09-04", statusOverride: "Absent" });
    expect([403, 404]).toContain(r.status);
  });
  test("[I] company B's attendance list does not include company A's employee", async () => {
    const r = await apiB.get("/attendance?date=2026-09-02");
    expect(JSON.stringify(r.body)).not.toContain(emp.userId);
  });
});

describe("Salary Management: payroll calculation", () => {
  let p; // employee with clean attendance for September 2026 (30 days)
  beforeAll(async () => {
    p = await createEmployee(apiA, 3, { salaryAmount: 30000, salaryConfig: { basic: { value: 30000 } } });
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, "0")}`;
      await apiA.patch("/attendance/admin-correct", { userId: p.userId, date, statusOverride: "Full Day" });
    }
  });

  const payrollFor = async (userId) => {
    const PayrollRecord = require("../models/payroll_record_model");
    return PayrollRecord.find({ employeeId: userId, month: 9, year: 2026 });
  };

  test("[C] full month present -> gross = fixed salary 30,000", async () => {
    const r = await apiA.post("/payroll/generate", { month: 9, year: 2026 });
    expect(r.status).toBe(200);
    const [rec] = await payrollFor(p.userId);
    expect(rec).toBeDefined();
    expect(rec.grossSalary).toBe(30000);
  });
  test("[C] net = gross - deductions, never negative", async () => {
    const [rec] = await payrollFor(p.userId);
    const deductions = (rec.deductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
    expect(rec.netSalary).toBeGreaterThanOrEqual(0);
    expect(Math.abs(rec.netSalary - (rec.grossSalary - deductions))).toBeLessThanOrEqual(1);
  });
  test("[-] generating the same month again does not create a duplicate", async () => {
    await apiA.post("/payroll/generate", { month: 9, year: 2026 });
    expect((await payrollFor(p.userId)).length).toBe(1);
  });
  test("[C] approved advance with 1,000 EMI is deducted in payroll", async () => {
    const q = await createEmployee(apiA, 4, { salaryAmount: 20000, salaryConfig: { basic: { value: 20000 } } });
    for (let d = 1; d <= 31; d++) {
      await apiA.patch("/attendance/admin-correct", { userId: q.userId, date: `2026-08-${String(d).padStart(2, "0")}`, statusOverride: "Full Day" });
    }
    const AdvanceSalary = require("../models/advance_salary_model");
    const adv = await AdvanceSalary.create({ employeeId: q.userId, type: "Advance Salary", amount: 3000, remainingAmount: 3000, monthlyInstallmentAmount: 1000, reason: "seed", status: "Approved", tenant_id: A.tenantId });
    await apiA.post("/payroll/generate", { month: 8, year: 2026 });
    const PayrollRecord = require("../models/payroll_record_model");
    const rec = await PayrollRecord.findOne({ employeeId: q.userId, month: 8, year: 2026 });
    const advDed = (rec.deductions || []).find((d) => /advance/i.test(d.label));
    expect(advDed?.amount).toBe(1000);
    expect((await AdvanceSalary.findById(adv._id)).remainingAmount).toBe(2000);
  });
  test("[-] payroll for month 13 creates no payslip", async () => {
    await apiA.post("/payroll/generate", { month: 13, year: 2026 });
    const PayrollRecord = require("../models/payroll_record_model");
    expect(await PayrollRecord.countDocuments({ month: 13 })).toBe(0);
  });
  test("[-] employee with only Base Salary (no breakdown) is not silently skipped", async () => {
    const z = await createEmployee(apiA, 5, { salaryAmount: 25000 });
    await apiA.patch("/attendance/admin-correct", { userId: z.userId, date: "2026-07-01", statusOverride: "Full Day" });
    await apiA.post("/payroll/generate", { month: 7, year: 2026 });
    const PayrollRecord = require("../models/payroll_record_model");
    expect(await PayrollRecord.countDocuments({ employeeId: z.userId, month: 7, year: 2026 })).toBe(1);
  });
  test("[I] company B payroll list does not show company A's payslips", async () => {
    const r = await apiB.get("/payroll?month=9&year=2026");
    expect(JSON.stringify(r.body)).not.toContain(p.userId);
  });
  test("[+] PF records for the month load", async () => {
    expect((await apiA.get("/payroll/pf-records?month=9&year=2026")).status).toBe(200);
  });
});

describe("Loans (loan policy)", () => {
  test("[+] admin saves a loan policy slab", async () => {
    const r = await apiA.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxSalary: null, maxLoan: 50000 }] });
    expect(r.status).toBe(200);
  });
  test("[-] maxLoan 0 is rejected", async () => {
    expect((await apiA.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxLoan: 0 }] })).status).toBe(400);
  });
  test("[-] negative minSalary is rejected", async () => {
    expect((await apiA.put("/advance-salary/loan-policy", { slabs: [{ minSalary: -5000, maxLoan: 1000 }] })).status).toBe(400);
  });
  test("[-] maxSalary below minSalary is rejected", async () => {
    expect((await apiA.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 50000, maxSalary: 10000, maxLoan: 1000 }] })).status).toBe(400);
  });
  test("[+] loan within the policy is accepted", async () => {
    await apiA.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxSalary: null, maxLoan: 50000 }] });
    expect((await emp.api.post("/advance-salary", { type: "Loan", amount: 10000, reason: "Bike" })).status).toBe(201);
  });
  test("[-] loan above the policy limit is rejected", async () => {
    expect((await emp.api.post("/advance-salary", { type: "Loan", amount: 999999, reason: "House" })).status).toBe(400);
  });
  test("[-] negative loan amount is rejected", async () => {
    expect((await emp.api.post("/advance-salary", { type: "Loan", amount: -10000, reason: "Neg" })).status).toBe(400);
  });
  test("[-] unknown type 'Gift' is rejected", async () => {
    expect((await emp.api.post("/advance-salary", { type: "Gift", amount: 100, reason: "x" })).status).toBe(400);
  });
});

describe("Salary Settlements", () => {
  test("[+] settlement list loads", async () => {
    expect((await apiA.get("/salary-settlements/list?month=9&year=2026")).status).toBe(200);
  });
  test("[-] brand slip amount -2000 is rejected", async () => {
    expect((await apiA.patch("/salary-settlements/set-brand-slip-amount", { id: String(new mongoose.Types.ObjectId()), brandSlipAmount: -2000 })).status).toBe(400);
  });
  test("[-] brand slip amount as text is rejected", async () => {
    expect((await apiA.patch("/salary-settlements/set-brand-slip-amount", { id: String(new mongoose.Types.ObjectId()), brandSlipAmount: "500" })).status).toBe(400);
  });
  test("[-] settling an unknown record is 404", async () => {
    expect((await apiA.patch("/salary-settlements/mark-settled", { id: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
  });
});

describe("Edit & Delete flows", () => {
  test("[+] edit shift name, [-] edit shift time to 99:99", async () => {
    const s = await apiA.post("/shifts", { name: "Edit Shift", startTime: "09:00", endTime: "17:00" });
    expect((await apiA.patch(`/shifts/${s.body.data._id}`, { name: "Edited Shift" })).status).toBe(200);
    expect((await apiA.patch(`/shifts/${s.body.data._id}`, { startTime: "99:99" })).status).toBe(400);
  });
  test("[-] edit holiday so endDate is before date", async () => {
    const h = await apiA.post("/holidays", { name: "Edit Hol", date: "2026-10-10" });
    expect((await apiA.put(`/holidays/${h.body.data._id}`, { endDate: "2026-10-01" })).status).toBe(400);
  });
  test("[-] edit department code to a code that already exists", async () => {
    await apiA.post("/departments", { name: "HR", code: "HR" });
    const d = await apiA.post("/departments", { name: "Ops", code: "OPS" });
    expect((await apiA.patch(`/departments/${d.body.data._id}`, { code: "HR" })).status).toBe(400);
  });
  test("[-] edit expense amount to -100", async () => {
    const e = await apiA.post("/expenses", { description: "Edit exp", amount: 100, category: "Travel" });
    expect((await apiA.put(`/expenses/${e.body.data._id}`, { amount: -100 })).status).toBe(400);
  });
  test("[-] edit branch latitude to 999", async () => {
    const b = await apiA.post("/hrms-branches", { name: "Edit Branch" });
    expect((await apiA.patch(`/hrms-branches/${b.body.data._id}`, { latitude: 999 })).status).toBe(400);
  });
  test("[-] edit employee mobile to 5 digits", async () => {
    expect((await apiA.put(`/users/${emp.userId}`, { mobile: "12345" })).status).toBe(400);
  });
  test("[I] company B cannot edit company A's shift", async () => {
    const s = await apiA.post("/shifts", { name: "Private Shift", startTime: "09:00", endTime: "17:00" });
    expect([403, 404]).toContain((await apiB.patch(`/shifts/${s.body.data._id}`, { name: "Hacked" })).status);
  });
  test("[I] company B cannot delete company A's department", async () => {
    const d = await apiA.post("/departments", { name: "Keep", code: "KEEP" });
    expect([403, 404]).toContain((await apiB.del(`/departments/${d.body.data._id}`)).status);
  });
  test("[I] company B cannot delete company A's holiday", async () => {
    const h = await apiA.post("/holidays", { name: "Keep Hol", date: "2026-10-20" });
    expect([403, 404]).toContain((await apiB.del(`/holidays/${h.body.data._id}`)).status);
  });
  test("[+] admin deletes a designation", async () => {
    const d = await apiA.post("/designations", { name: "Temp", code: "TMP" });
    expect((await apiA.del(`/designations/${d.body.data._id}`)).status).toBe(200);
  });
  test("[-] deleting a department that still has employees is blocked", async () => {
    const d = await apiA.post("/departments", { name: "Busy", code: "BUSY" });
    await apiA.put(`/users/${emp.userId}`, { department: d.body.data._id });
    const User = require("../models/user_model");
    expect(String((await User.findById(emp.userId)).department)).toBe(String(d.body.data._id));
    expect((await apiA.del(`/departments/${d.body.data._id}`)).status).toBe(400);
  });
});
