// HRMS Part D — Payroll calculation against HAND-CALCULATED numbers (04-hrms.md rules 24-33).
// Test month: September 2026 (30 days; Sep 1 = Tuesday; Sundays 6, 13, 20, 27; 26 working days Mon-Sat).
// Company holiday: Tue 15 Sep 2026. Base per-day = monthly ÷ 30. Every expected number is written
// out in test-results/hrms-money/REPORT.md ("Payroll hand calculation").
const mongoose = require("mongoose");
const { start, stop, seedTenant, seedStandardPeople } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(180000);
const M = 9, YR = 2026;
const oid = (s) => new mongoose.Types.ObjectId(String(s));
const pad = (d) => `2026-09-${String(d).padStart(2, "0")}`;
const SUNDAYS = [6, 13, 20, 27];
const SATURDAYS = [5, 12, 19, 26];
const WORKING = Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => !SUNDAYS.includes(d)); // 26 days
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

let P, Q, E = {}, rec = {}, db;

async function att(userId, days, status = "Full Day", extra = {}) {
  if (!days.length) return;
  await db.collection("attendances").insertMany(days.map((d) => ({ userId: oid(userId), date: pad(d), status, totalHours: status === "Full Day" ? 9 : 4.5, ...(extra[d] || {}) })));
}
async function leave(userId, type, from, to, totalDays, isHalfDay = false) {
  await db.collection("leaverequests").insertOne({ employeeId: oid(userId), leaveTypeId: type, fromDate: new Date(`${pad(from)}T00:00:00Z`), toDate: new Date(`${pad(to)}T00:00:00Z`), totalDays, isHalfDay, reason: "test", status: "approved", tenant_id: P.tenantId });
}
async function structure(name, s) {
  const _id = new mongoose.Types.ObjectId();
  await db.collection("salarystructures").insertOne({ _id, type: "structure", name, basic: 0, hra: 0, conveyance: 0, medicalAllowance: 0, specialAllowance: 0, pfApplicable: false, esicApplicable: false, professionalTax: 0, standardDeductions: [], isActive: true, ...s });
  return _id;
}
async function advance(emp, body, approve) {
  const c = await P.api.post("/advance-salary", { employeeId: emp.userId, reason: "test", ...body });
  if (c.status !== 201) throw new Error(`advance create ${c.status} ${JSON.stringify(c.body)}`);
  const a = await P.api.put(`/advance-salary/${c.body.data._id}`, { status: "Approved", ...approve });
  if (a.status !== 200) throw new Error(`advance approve ${a.status} ${JSON.stringify(a.body)}`);
  return c.body.data._id;
}
const adv = (id) => db.collection("advancesalaries").findOne({ _id: oid(id) });
const ded = (r, label) => (r.deductions.find((d) => d.label === label) || {}).amount || 0;

beforeAll(async () => {
  await start();
  db = mongoose.connection.db;
  P = await seedStandardPeople(await seedTenant("PayCo"));
  Q = await seedTenant("OtherPayCo");
  // The standard people (emp 30000, emp2 20000) have no attendance → generated at ₹0; not asserted here.
  await db.collection("holidays").insertOne({ tenant_id: P.tenantId, name: "Test Festival", date: "2026-09-15", type: "Festival", isActive: true });
  const otShift = new mongoose.Types.ObjectId();
  const monFri = new mongoose.Types.ObjectId();
  await db.collection("shifts").insertMany([
    { _id: otShift, name: "OT shift", startTime: "09:00", endTime: "18:00", overtimeRatePerHour: 100, workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], tenant_id: P.tenantId },
    { _id: monFri, name: "Mon-Fri shift", startTime: "09:00", endTime: "18:00", overtimeRatePerHour: 0, workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], tenant_id: P.tenantId },
  ]);
  const paidType = new mongoose.Types.ObjectId();
  const unpaidType = new mongoose.Types.ObjectId();
  await db.collection("leavetypes").insertMany([
    { _id: paidType, name: "Casual P", code: "CLP", isPaid: true, yearlyQuota: 12, tenant_id: P.tenantId, isActive: true },
    { _id: unpaidType, name: "LWP P", code: "LWPP", isPaid: false, yearlyQuota: 0, tenant_id: P.tenantId, isActive: true },
  ]);

  // E0 baseline: every working day incl. the holiday.
  E.e0 = await P.addPerson("e0", { salaryAmount: 30000 });
  await att(E.e0.userId, WORKING);
  // E1 holiday: every working day except the 15th (holiday).
  E.e1 = await P.addPerson("e1", { salaryAmount: 30000 });
  await att(E.e1.userId, WORKING.filter((d) => d !== 15));
  // E2 half days / absent / weekly-off adjacency / overtime 240 min @ ₹100/h.
  E.e2 = await P.addPerson("e2", { salaryAmount: 30000, extra: { shiftId: otShift } });
  await att(E.e2.userId, [1, 4, 5, ...range(7, 12), ...range(14, 18), 29, 30], "Full Day", { 7: { overtimeMinutes: 90 }, 8: { overtimeMinutes: 150 } });
  await att(E.e2.userId, [2, 3], "Half Day");
  await att(E.e2.userId, [19], "Absent");
  // E3 leave: paid 8-10, paid 12-14 (spans Sunday 13), unpaid 22, half-day paid 24 (+ Half Day attendance),
  // paid 29 AND Full Day attendance on 29 (must count once).
  E.e3 = await P.addPerson("e3", { salaryAmount: 30000 });
  await att(E.e3.userId, WORKING.filter((d) => ![8, 9, 10, 12, 14, 22, 24].includes(d)));
  await att(E.e3.userId, [24], "Half Day");
  await leave(E.e3.userId, paidType, 8, 10, 3);
  await leave(E.e3.userId, paidType, 12, 14, 2);
  await leave(E.e3.userId, unpaidType, 22, 22, 1);
  await leave(E.e3.userId, paidType, 24, 24, 0.5, true);
  await leave(E.e3.userId, paidType, 29, 29, 1);
  // E4a PF 12% of basic (per-day mode, no amount), ESIC 0.75%, PT 200, full attendance.
  E.e4a = await P.addPerson("e4a", { extra: { salaryStructureId: await structure("S-e4a", { basic: 10000, hra: 4000, conveyance: 1000, medicalAllowance: 500, specialAllowance: 1500, pfApplicable: true, pfMode: "per_day", pfRate: 12, esicApplicable: true, professionalTax: 200 }) } });
  await att(E.e4a.userId, WORKING);
  // E4b ESIC on a ₹24,000 salary, half month attended (11 days).
  E.e4b = await P.addPerson("e4b", { extra: { salaryStructureId: await structure("S-e4b", { basic: 24000, esicApplicable: true }) } });
  await att(E.e4b.userId, [...range(1, 5), ...range(7, 12)]);
  // E4c fixed monthly PF ₹1,800 + PT 200, 10 days attended.
  E.e4c = await P.addPerson("e4c", { extra: { salaryStructureId: await structure("S-e4c", { basic: 20000, pfApplicable: true, pfMode: "fixed_monthly", professionalTax: 200, standardDeductions: [{ name: "PF (Employee)", amount: 1800 }] }) } });
  await att(E.e4c.userId, [...range(1, 5), ...range(7, 11)]);
  // E4d per-day PF ₹50/day, 5 days attended.
  E.e4d = await P.addPerson("e4d", { extra: { salaryStructureId: await structure("S-e4d", { basic: 15000, pfApplicable: true, pfMode: "per_day", standardDeductions: [{ name: "PF (Employee)", amount: 50 }] }) } });
  await att(E.e4d.userId, range(1, 5));
  // E4e no attendance at all, fixed PF + PT + an approved ₹5,000 advance.
  E.e4e = await P.addPerson("e4e", { extra: { salaryStructureId: await structure("S-e4e", { basic: 20000, pfApplicable: true, pfMode: "fixed_monthly", professionalTax: 200, standardDeductions: [{ name: "PF (Employee)", amount: 1800 }] }) } });
  E.e4e.adv = await advance(E.e4e, { amount: 5000, type: "Advance Salary" });
  // E5 full attendance; advance 5,000 + loan 20,000 EMI 3,000.
  E.e5 = await P.addPerson("e5", { salaryAmount: 30000 });
  await att(E.e5.userId, WORKING);
  E.e5.adv = await advance(E.e5, { amount: 5000, type: "Advance Salary" });
  E.e5.loan = await advance(E.e5, { amount: 20000, type: "Loan" }, { monthlyInstallmentAmount: 3000 });
  // E6 loan 5,000 EMI 3,000, manual repayment 3,000 → balance 2,000 (EMI must cap at 2,000).
  E.e6 = await P.addPerson("e6", { salaryAmount: 30000 });
  await att(E.e6.userId, WORKING);
  E.e6.loan = await advance(E.e6, { amount: 5000, type: "Loan" }, { monthlyInstallmentAmount: 3000 });
  await P.api.post(`/advance-salary/${E.e6.loan}/repay`, { amount: 3000, note: "cash" });
  // E7 advance 20,000 but only 2 days worked.
  E.e7 = await P.addPerson("e7", { salaryAmount: 30000 });
  await att(E.e7.userId, [1, 2]);
  E.e7.adv = await advance(E.e7, { amount: 20000, type: "Advance Salary" });
  // E8 left mid-month (inactive now), worked 1-15.
  E.e8 = await P.addPerson("e8", { salaryAmount: 30000 });
  await att(E.e8.userId, WORKING.filter((d) => d <= 15));
  await db.collection("users").updateOne({ _id: oid(E.e8.userId) }, { $set: { isActive: false } });
  // E9 shift works Mon-Fri; attends every Mon-Fri.
  E.e9 = await P.addPerson("e9", { salaryAmount: 30000, extra: { shiftId: monFri } });
  await att(E.e9.userId, WORKING.filter((d) => !SATURDAYS.includes(d)));

  const g = await P.api.post("/payroll/generate", { month: M, year: YR });
  if (g.status !== 200) throw new Error(`generate ${g.status} ${JSON.stringify(g.body)}`);
  for (const [k, e] of Object.entries(E)) rec[k] = g.body.data.find((r) => String(r.employeeId) === e.userId) || null;
  require("fs").writeFileSync(require("path").resolve(__dirname, "../../../../test-results/hrms-money/raw/payroll-generated.json"),
    JSON.stringify(Object.fromEntries(Object.entries(rec).map(([k, r]) => [k, r && { payableDays: r.payableDays, presentDays: r.presentDays, leaveDays: r.leaveDays, unpaidLeaveDays: r.unpaidLeaveDays, absentDays: r.absentDays, overtimeMinutes: r.overtimeMinutes, grossSalary: r.grossSalary, netSalary: r.netSalary, deductions: r.deductions, additions: r.additions }])), null, 2));
});
afterAll(stop);

const pick = (r) => r && { payable: r.payableDays, gross: r.grossSalary, net: r.netSalary };

describe("Rules 24-27 — present days, leave, weekly offs, payable days × factor", () => {
  test("[+] E0 full month (26 working days incl. holiday) → payable 30, gross 30,000, net 30,000", () => {
    expect(pick(rec.e0)).toEqual({ payable: 30, gross: 30000, net: 30000 });
  });
  test("[BUG?] E1 rule 30 — holiday (15 Sep) is a PAID day → payable 30, gross 30,000", () => {
    expect(pick(rec.e1)).toEqual({ payable: 30, gross: 30000, net: 30000 });
  });
  test("[+] E2 present = 15 FD + 2×0.5 HD + 2 = 17; offs 6,13 paid, 20,27 not → payable 19; 19,000 + OT 400 = 19,400", () => {
    expect(rec.e2.presentDays).toBe(17);
    expect(pick(rec.e2)).toEqual({ payable: 19, gross: 19400, net: 19400 });
  });
  test("[+] E2 rule 28 — overtime 240 min ÷ 60 × ₹100 = ₹400 as an 'Overtime' addition", () => {
    expect(rec.e2.overtimeMinutes).toBe(240);
    expect(rec.e2.additions).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Overtime", amount: 400 })]));
  });
  test("[BUG?] E3 rules 25/31 — paid leave counts, unpaid doesn't, half-day leave 0.5, attendance+leave day counted ONCE → payable 29, gross 29,000", () => {
    expect(pick(rec.e3)).toEqual({ payable: 29, gross: 29000, net: 29000 });
  });
  test("[BUG?] E3 — the unpaid leave day (22 Sep) shows as loss-of-pay (≥ 1 unpaid day)", () => {
    expect(rec.e3.unpaidLeaveDays).toBeGreaterThanOrEqual(1);
  });
  test("[BUG?] E9 — shift working days Mon-Fri are used: Saturdays are weekly offs → payable 30, gross 30,000", () => {
    expect(pick(rec.e9)).toEqual({ payable: 30, gross: 30000, net: 30000 });
  });
  test("[BUG?] E8 left mid-month (now inactive) still gets a payslip for 1-15 Sep → payable 15, gross 15,000", () => {
    expect(pick(rec.e8)).toEqual({ payable: 15, gross: 15000, net: 15000 });
  });
});

describe("Rule 29 — PF / ESIC / PT / advance / loan; deductions never more than earned pay", () => {
  test("[+] E4a gross 17,000; PF 12% of 10,000 = 1,200; ESIC 0.75% = 127.50 (₹128); PT 200", () => {
    expect(rec.e4a.grossSalary).toBe(17000);
    expect({ pf: ded(rec.e4a, "PF (Employee)"), esic: ded(rec.e4a, "ESIC"), pt: ded(rec.e4a, "PT") }).toEqual({ pf: 1200, esic: 128, pt: 200 });
  });
  test("[BUG?] E4a payslip adds up: net = gross − sum of the deduction lines (17,000 − 1,528 = 15,472)", () => {
    const sum = rec.e4a.deductions.reduce((s, d) => s + d.amount, 0);
    expect(rec.e4a.netSalary).toBe(rec.e4a.grossSalary - sum);
  });
  test("[BUG?] E4b ESIC eligibility uses the full monthly wage (₹24,000 > ₹21,000) → no ESIC even on a short month", () => {
    expect(rec.e4b.grossSalary).toBe(10400); // 24,000 × 13/30
    expect(ded(rec.e4b, "ESIC")).toBe(0);
  });
  test("[+] E4c fixed monthly PF ₹1,800 not prorated; PT 200 × 11/30 = 73; gross 7,333; net 5,460", () => {
    expect({ gross: rec.e4c.grossSalary, pf: ded(rec.e4c, "PF (Employee)"), pt: ded(rec.e4c, "PT"), net: rec.e4c.netSalary }).toEqual({ gross: 7333, pf: 1800, pt: 73, net: 5460 });
  });
  test("[+] E4d per-day PF ₹50 × 6 payable days = ₹300; gross 3,000; net 2,700", () => {
    expect({ gross: rec.e4d.grossSalary, pf: ded(rec.e4d, "PF (Employee)"), net: rec.e4d.netSalary }).toEqual({ gross: 3000, pf: 300, net: 2700 });
  });
  test("[+] E4e zero attendance → gross 0, no deductions, net 0; the advance stays outstanding", async () => {
    expect({ gross: rec.e4e.grossSalary, net: rec.e4e.netSalary, lines: rec.e4e.deductions.length }).toEqual({ gross: 0, net: 0, lines: 0 });
    const a = await adv(E.e4e.adv);
    expect({ status: a.status, remaining: a.remainingAmount }).toEqual({ status: "Approved", remaining: 5000 });
  });
  test("[+] E5 advance recovered in full (5,000) + loan EMI 3,000 → net 22,000; advance Repaid, loan balance 17,000", async () => {
    expect({ adv: ded(rec.e5, "Advance Salary Repayment"), loan: ded(rec.e5, "Loan Repayment"), net: rec.e5.netSalary }).toEqual({ adv: 5000, loan: 3000, net: 22000 });
    const a = await adv(E.e5.adv); const l = await adv(E.e5.loan);
    expect({ a: [a.status, a.remainingAmount], l: [l.status, l.remainingAmount] }).toEqual({ a: ["Repaid", 0], l: ["Approved", 17000] });
  });
  test("[+] E6 loan EMI capped at the 2,000 balance → net 28,000, loan Repaid", async () => {
    expect({ loan: ded(rec.e6, "Loan Repayment"), net: rec.e6.netSalary }).toEqual({ loan: 2000, net: 28000 });
    expect((await adv(E.e6.loan)).status).toBe("Repaid");
  });
  test("[+] E7 earned 2,000 → advance deduction capped at 2,000, net 0, advance balance 18,000", async () => {
    expect({ gross: rec.e7.grossSalary, adv: ded(rec.e7, "Advance Salary Repayment"), net: rec.e7.netSalary }).toEqual({ gross: 2000, adv: 2000, net: 0 });
    expect((await adv(E.e7.adv)).remainingAmount).toBe(18000);
  });
});

describe("Rule 32 — re-generate refunds, paid records locked", () => {
  test("[+] re-generating the month gives the same numbers and does NOT deduct the advance/loan twice", async () => {
    const g = await P.api.post("/payroll/generate", { month: M, year: YR });
    const r5 = g.body.data.find((r) => String(r.employeeId) === E.e5.userId);
    expect(r5.netSalary).toBe(22000);
    const a = await adv(E.e5.adv); const l = await adv(E.e5.loan);
    expect({ a: a.remainingAmount, l: l.remainingAmount, ai: a.installments.length, li: l.installments.length }).toEqual({ a: 0, l: 17000, ai: 1, li: 1 });
  });
  test("[+] a PAID record is not regenerated", async () => {
    const id = rec.e0._id;
    expect((await P.api.patch(`/payroll/${id}/approve`)).status).toBe(200);
    expect((await P.api.patch(`/payroll/${id}/pay`)).status).toBe(200);
    await db.collection("attendances").deleteMany({ userId: oid(E.e0.userId) }); // would make it ₹0 if regenerated
    await P.api.post("/payroll/generate", { month: M, year: YR });
    const r = await db.collection("payrollrecords").findOne({ _id: oid(id) });
    expect({ status: r.status, net: r.netSalary }).toEqual({ status: "paid", net: 30000 });
  });
  test("[BUG?] approving a PAID record must not revert it to Due", async () => {
    const r = await P.api.patch(`/payroll/${rec.e0._id}/approve`);
    const doc = await db.collection("payrollrecords").findOne({ _id: oid(rec.e0._id) });
    expect({ http: r.status >= 400 ? "refused" : "ok", paymentStatus: doc.paymentStatus, status: doc.status }).toEqual({ http: "refused", paymentStatus: "Paid", status: "paid" });
  });
  test("[BUG?] a PAID record cannot be deleted", async () => {
    await db.collection("payrollrecords").updateOne({ _id: oid(rec.e0._id) }, { $set: { status: "paid", paymentStatus: "Paid" } });
    const r = await P.api.del(`/payroll/${rec.e0._id}`);
    expect({ http: r.status >= 400 ? "refused" : "ok", exists: !!(await db.collection("payrollrecords").findOne({ _id: oid(rec.e0._id) })) }).toEqual({ http: "refused", exists: true });
  });
  test("[BUG?] approve/pay with an EMPLOYEE id (not a record id) → 404, no record changed", async () => {
    const r = await P.api.patch(`/payroll/${E.e2.userId}/pay`);
    const doc = await db.collection("payrollrecords").findOne({ employeeId: oid(E.e2.userId), month: M, year: YR });
    expect({ http: r.status, status: doc.status }).toEqual({ http: 404, status: "generated" });
  });
  test("[+] deleting an UNPAID record gives back its advance/loan deductions", async () => {
    await P.api.del(`/payroll/${rec.e7._id}`);
    expect((await adv(E.e7.adv)).remainingAmount).toBe(20000);
  });
});

describe("Rule 33 / security — employees see only their own salary and slip", () => {
  test("[BUG?] a normal employee listing /payroll is refused (403) or sees only own rows", async () => {
    const r = await E.e1.api.get(`/payroll?month=${M}&year=${YR}`);
    const others = r.status === 200 ? r.body.data.filter((x) => String(x.employeeId?._id || x.employeeId) !== E.e1.userId).length : 0;
    expect(others).toBe(0);
  });
  test("[BUG?] a normal employee cannot open a colleague's slip via /payroll/:id/slip", async () => {
    const r = await E.e1.api.get(`/payroll/${rec.e5._id}/slip`);
    expect([403, 404]).toContain(r.status);
  });
  test("[+] /payroll/me returns only own rows; /payroll/me/:id/slip of colleague → 404", async () => {
    const r = await E.e1.api.get("/payroll/me");
    expect(r.body.data.every((x) => String(x.employeeId?._id) === E.e1.userId)).toBe(true);
    expect((await E.e1.api.get(`/payroll/me/${rec.e5._id}/slip`)).status).toBe(404);
  });
  test("[+] own slip opens and its net = payroll net", async () => {
    const r = await E.e5.api.get(`/payroll/me/${rec.e5._id}/slip`);
    expect(r.status).toBe(200);
    expect(r.body.data.netPay).toBe(22000);
  });
  test("[BUG?] the slip never uses ANOTHER company's default salary-slip template", async () => {
    await Q.api.post("/salary-templates", { name: "Q default", isDefault: true, companyName: "OTHER COMPANY BRANDING" });
    const r = await P.api.get(`/payroll/${rec.e5._id}/slip`);
    expect(r.body.data.template?.companyName || "").not.toBe("OTHER COMPANY BRANDING");
  });
  test("[BUG?] a normal employee cannot create/overwrite the company's salary-slip template", async () => {
    const r = await E.e1.api.post("/salary-templates", { name: "Hacked", isDefault: true, companyName: "Hacked Pvt Ltd" });
    expect(r.status).toBe(403);
  });
  test("[+] employee cannot generate / approve / pay / delete payroll (403)", async () => {
    expect((await E.e1.api.post("/payroll/generate", { month: M, year: YR })).status).toBe(403);
    expect((await E.e1.api.patch(`/payroll/${rec.e1._id}/approve`)).status).toBe(403);
    expect((await E.e1.api.patch(`/payroll/${rec.e1._id}/pay`)).status).toBe(403);
    expect((await E.e1.api.del(`/payroll/${rec.e1._id}`)).status).toBe(403);
  });
  test("[+] payroll manager (Salary Management) can generate; screen-only desync user cannot (403)", async () => {
    expect((await P.people.paymgr.api.post("/payroll/generate", { month: 8, year: YR })).status).toBe(200);
    expect((await P.people.desync.api.post("/payroll/generate", { month: 8, year: YR })).status).toBe(403);
  });
  test("[BUG?] branch supervisor's payroll list is narrowed to own branch staff", async () => {
    const r = await P.people.sup.api.get(`/payroll?month=${M}&year=${YR}`);
    const branchStaff = new Set([P.people.emp.userId, P.people.sup.userId]);
    const outside = r.status === 200 ? r.body.data.filter((x) => !branchStaff.has(String(x.employeeId?._id))).length : 0;
    expect(outside).toBe(0);
  });
  test("[+] other company: list empty, slip/approve/delete → 404", async () => {
    const r = await Q.api.get(`/payroll?month=${M}&year=${YR}`);
    expect(r.body.data.length).toBe(0);
    expect((await Q.api.get(`/payroll/${rec.e5._id}/slip`)).status).toBe(404);
    expect((await Q.api.patch(`/payroll/${rec.e5._id}/approve`)).status).toBe(404);
    expect((await Q.api.del(`/payroll/${rec.e5._id}`)).status).toBe(404);
  });
  test("[+] generate validation: month 13 / 0 / year 1999 / missing → 400", async () => {
    for (const b of [{ month: 13, year: YR }, { month: 0, year: YR }, { month: 5, year: 1999 }, {}]) expect((await P.api.post("/payroll/generate", b)).status).toBe(400);
  });
});

describe("PF Records / My PF", () => {
  test("[+] admin PF records list the PF employees with the PF actually deducted", async () => {
    const r = await P.api.get(`/payroll/pf-records?month=${M}&year=${YR}`);
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.data.map((x) => [x.name, x.pfDeducted]));
    expect(byName).toMatchObject({ "e4a PayCo": 1200, "e4c PayCo": 1800, "e4d PayCo": 300 });
  });
  test("[+] employee → /pf-records 403; /pf-records/me shows own PF only", async () => {
    expect((await E.e1.api.get(`/payroll/pf-records?month=${M}&year=${YR}`)).status).toBe(403);
    const r = await E.e4a.api.get(`/payroll/pf-records/me?year=${YR}`);
    expect(r.body.data.totalPfDeducted).toBe(1200);
  });
  test("[+] PF records without month/year → 400", async () => {
    expect((await P.api.get("/payroll/pf-records")).status).toBe(400);
  });
});
