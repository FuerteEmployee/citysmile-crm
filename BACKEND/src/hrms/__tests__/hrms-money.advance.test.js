// HRMS Part D — Advance Salary / Loans (rules 34-36, field rules, suspected bug 11).
const mongoose = require("mongoose");
const { start, stop, seedTenant, seedStandardPeople } = require("../../testUtils/hrms-money.harness");

jest.setTimeout(120000);
let A, B, db;
const raw = (id) => db.collection("advancesalaries").findOne({ _id: new mongoose.Types.ObjectId(id) });
const req = (p, body) => p.api.post("/advance-salary", { reason: "Medical", ...body });

beforeAll(async () => {
  await start();
  db = mongoose.connection.db;
  A = await seedStandardPeople(await seedTenant("AdvA"));
  B = await seedStandardPeople(await seedTenant("AdvB"));
});
afterAll(stop);

describe("Rule 34 — limits", () => {
  test("[+] advance cap = 100% of fixed salary (30,000): 30,000 ok, then 1 more refused", async () => {
    const p = await A.addPerson("cap", { salaryAmount: 30000 });
    expect((await req(p, { amount: 30000 })).status).toBe(201);
    expect((await req(p, { amount: 1 })).status).toBe(400);
  });
  test("[+] advance over the cap (30,001) → 400", async () => {
    const p = await A.addPerson("cap2", { salaryAmount: 30000 });
    expect((await req(p, { amount: 30001 })).status).toBe(400);
  });
  test("[+] limit endpoint: maxAllowed 30,000, outstanding counts pending + approved remaining", async () => {
    const p = await A.addPerson("cap3", { salaryAmount: 30000 });
    await req(p, { amount: 10000 });
    const r = await p.api.get("/advance-salary/limit/me");
    expect(r.body.data).toMatchObject({ maxAllowed: 30000, outstanding: 10000, available: 20000 });
  });
  test("[+] no salary set → advance refused", async () => {
    const p = await A.addPerson("nosal");
    expect((await req(p, { amount: 100 })).status).toBe(400);
  });
  test("[+] loan default limit = 10 × salary (3,00,000 ok; 3,00,001 refused)", async () => {
    const p = await A.addPerson("loan10", { salaryAmount: 30000 });
    expect((await req(p, { amount: 300001, type: "Loan" })).status).toBe(400);
    expect((await req(p, { amount: 300000, type: "Loan" })).status).toBe(201);
  });
  test("[+] loan slab limit applies (20,000–35,000 → max 1,00,000)", async () => {
    expect((await A.api.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 20000, maxSalary: 35000, maxLoan: 100000 }] })).status).toBe(200);
    const p = await A.addPerson("slab", { salaryAmount: 30000 });
    expect((await req(p, { amount: 100001, type: "Loan" })).status).toBe(400);
    expect((await req(p, { amount: 100000, type: "Loan" })).status).toBe(201);
  });
  test("[+] overlapping slabs refused; touching slabs ok", async () => {
    expect((await A.api.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxSalary: 30000, maxLoan: 1 }, { minSalary: 25000, maxSalary: null, maxLoan: 2 }] })).status).toBe(400);
    expect((await A.api.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxSalary: 20000, maxLoan: 50000 }, { minSalary: 20000, maxSalary: 35000, maxLoan: 100000 }] })).status).toBe(200);
  });
  test("[+] employee cannot change loan policy (403)", async () => {
    expect((await A.people.emp.api.put("/advance-salary/loan-policy", { slabs: [{ minSalary: 0, maxSalary: null, maxLoan: 99999999 }] })).status).toBe(403);
  });
});

describe("Field rules — amount > 0, reason required, EMI ₹1..loan amount", () => {
  test.each([["0", 0], ["-500", -500], ["abc", "abc"], ["missing", undefined]])("[+] amount %s → 400", async (_l, v) => {
    expect((await req(A.people.emp, { amount: v })).status).toBe(400);
  });
  test("[+] reason missing → 400", async () => {
    expect((await A.people.emp.api.post("/advance-salary", { amount: 100 })).status).toBe(400);
  });
  test("[BUG?] reason of only spaces → 400", async () => {
    expect((await req(A.people.emp, { amount: 100, reason: "   " })).status).toBe(400);
  });
  test("[+] loan approval without EMI → 400; EMI 0 / more than loan → 400; valid EMI → 200", async () => {
    const p = await A.addPerson("emi", { salaryAmount: 30000 });
    const id = (await req(p, { amount: 10000, type: "Loan" })).body.data._id;
    expect((await A.api.put(`/advance-salary/${id}`, { status: "Approved" })).status).toBe(400);
    expect((await A.api.put(`/advance-salary/${id}`, { status: "Approved", monthlyInstallmentAmount: 0 })).status).toBe(400);
    expect((await A.api.put(`/advance-salary/${id}`, { status: "Approved", monthlyInstallmentAmount: 10001 })).status).toBe(400);
    expect((await A.api.put(`/advance-salary/${id}`, { status: "Approved", monthlyInstallmentAmount: 1000 })).status).toBe(200);
  });
});

describe("Rule 35 — approve sets remaining; repayment 0..outstanding; Repaid only from Approved", () => {
  let p, id;
  beforeAll(async () => {
    p = await A.addPerson("r35", { salaryAmount: 30000 });
    id = (await req(p, { amount: 9000 })).body.data._id;
  });
  test("[+] approve → remainingAmount = 9,000", async () => {
    await A.api.put(`/advance-salary/${id}`, { status: "Approved" });
    expect((await raw(id)).remainingAmount).toBe(9000);
  });
  test("[+] repay 0 / more than outstanding → 400; repay 4,000 → remaining 5,000", async () => {
    expect((await A.api.post(`/advance-salary/${id}/repay`, { amount: 0 })).status).toBe(400);
    expect((await A.api.post(`/advance-salary/${id}/repay`, { amount: 9001 })).status).toBe(400);
    expect((await A.api.post(`/advance-salary/${id}/repay`, { amount: 4000 })).status).toBe(200);
    expect((await raw(id)).remainingAmount).toBe(5000);
  });
  test("[BUG?] re-approving an already approved, part-repaid advance must NOT reset remaining back to 9,000", async () => {
    await A.api.put(`/advance-salary/${id}`, { status: "Approved" });
    expect((await raw(id)).remainingAmount).toBe(5000);
  });
  test("[+] employee cannot record a repayment (403)", async () => {
    expect((await p.api.post(`/advance-salary/${id}/repay`, { amount: 1 })).status).toBe(403);
  });
  test("[+] Repaid from Pending is refused", async () => {
    const id2 = (await req(p, { amount: 100 })).body.data._id;
    expect((await A.api.put(`/advance-salary/${id2}`, { status: "Repaid" })).status).toBe(400);
  });
  test("[BUG?] a Repaid / Rejected record cannot be re-opened by setting status Approved", async () => {
    const id3 = (await req(p, { amount: 100 })).body.data._id;
    await A.api.put(`/advance-salary/${id3}`, { status: "Rejected" });
    const r = await A.api.put(`/advance-salary/${id3}`, { status: "Approved" });
    expect(r.status).toBe(400);
  });
});

describe("Rule 36 — employee cannot change amount/type after approval, cannot send extra fields", () => {
  test("[BUG?] create ignores remainingAmount / installments / monthlyInstallmentAmount / approvedBy sent by the employee", async () => {
    const p = await A.addPerson("extra", { salaryAmount: 30000 });
    const r = await req(p, { amount: 10000, remainingAmount: 0, monthlyInstallmentAmount: 1, approvedBy: A.admin.userId, installments: [{ month: 1, year: 2026, amount: 9999 }] });
    const d = await raw(r.body.data._id);
    expect({ rem: d.remainingAmount, emi: d.monthlyInstallmentAmount, by: d.approvedBy, inst: d.installments.length })
      .toEqual({ rem: null, emi: 0, by: null, inst: 0 });
  });
  test("[+] advance with an employee-sent ₹1 'installment' is still recovered IN FULL by payroll", async () => {
    const p = await A.addPerson("emi1", { salaryAmount: 30000 });
    const id = (await req(p, { amount: 6000, monthlyInstallmentAmount: 1 })).body.data._id;
    await A.api.put(`/advance-salary/${id}`, { status: "Approved" });
    const d = await raw(id);
    expect(d.monthlyInstallmentAmount).toBe(0); // approval path forces 0 for Advance Salary
  });
  test("[BUG?] after approval the employee cannot change the amount", async () => {
    const p = await A.addPerson("amt", { salaryAmount: 30000 });
    const id = (await req(p, { amount: 5000 })).body.data._id;
    await A.api.put(`/advance-salary/${id}`, { status: "Approved" });
    const r = await p.api.put(`/advance-salary/${id}`, { amount: 1000 });
    expect({ http: r.status >= 400 ? "refused" : "ok", amount: (await raw(id)).amount }).toEqual({ http: "refused", amount: 5000 });
  });
  test("[BUG?] after approval the employee cannot change the type (Advance → Loan)", async () => {
    const p = await A.addPerson("typ", { salaryAmount: 30000 });
    const id = (await req(p, { amount: 5000 })).body.data._id;
    await A.api.put(`/advance-salary/${id}`, { status: "Approved" });
    await p.api.put(`/advance-salary/${id}`, { type: "Loan" });
    expect((await raw(id)).type).toBe("Advance Salary");
  });
  test("[+] employee cannot set the status of own request (403)", async () => {
    const p = await A.addPerson("st", { salaryAmount: 30000 });
    const id = (await req(p, { amount: 500 })).body.data._id;
    expect((await p.api.put(`/advance-salary/${id}`, { status: "Approved" })).status).toBe(403);
    expect((await p.api.put(`/advance-salary/${id}`, { status: "Repaid" })).status).toBe(403);
  });
  test("[+] employee cannot edit a colleague's request (403)", async () => {
    const id = (await req(A.people.emp, { amount: 500 })).body.data._id;
    expect((await A.people.emp2.api.put(`/advance-salary/${id}`, { reason: "x" })).status).toBe(403);
  });
  test("[+] employee cannot raise an advance on behalf of a colleague (saved for self instead)", async () => {
    const r = await req(A.people.emp, { amount: 100, employeeId: A.people.emp2.userId });
    expect(String(r.body.data.employeeId._id || r.body.data.employeeId)).toBe(A.people.emp.userId);
  });
});

describe("Visibility / roles / company separation", () => {
  test("[+] employee list shows only own records; supervisor sees own branch; admin all", async () => {
    await req(A.people.emp2, { amount: 200 });
    const own = await A.people.emp.api.get("/advance-salary");
    expect(own.body.data.every((x) => String(x.employeeId._id) === A.people.emp.userId)).toBe(true);
    const sup = await A.people.sup.api.get("/advance-salary");
    expect(sup.body.data.some((x) => String(x.employeeId._id) === A.people.emp2.userId)).toBe(false);
  });
  test("[+] employee cannot read a colleague's record by id (403)", async () => {
    const id = (await req(A.people.emp2, { amount: 150 })).body.data._id;
    expect((await A.people.emp.api.get(`/advance-salary/${id}`)).status).toBe(403);
  });
  test("[+] employee asking the limit of a colleague gets their OWN limit", async () => {
    const r = await A.people.emp.api.get(`/advance-salary/limit/${A.people.emp2.userId}`);
    expect(r.body.data.fixedSalary).toBe(30000);
  });
  test("[+] only admin deletes (employee 403); other company → 404", async () => {
    const id = (await req(A.people.emp, { amount: 120 })).body.data._id;
    expect((await A.people.emp.api.del(`/advance-salary/${id}`)).status).toBe(403);
    expect((await B.api.del(`/advance-salary/${id}`)).status).toBe(404);
    expect((await B.api.put(`/advance-salary/${id}`, { status: "Approved" })).status).toBe(404);
    expect((await A.api.del(`/advance-salary/${id}`)).status).toBe(200);
  });
  test("[+] supervisor can approve own-branch staff; not other branch", async () => {
    const id1 = (await req(A.people.emp, { amount: 130 })).body.data._id;
    const id2 = (await req(A.people.emp2, { amount: 130 })).body.data._id;
    expect((await A.people.sup.api.put(`/advance-salary/${id1}`, { status: "Approved" })).status).toBe(200);
    expect((await A.people.sup.api.put(`/advance-salary/${id2}`, { status: "Approved" })).status).toBe(403);
  });
  test("[+] malformed id → 4xx", async () => {
    expect((await A.api.get("/advance-salary/zzz")).status).toBeLessThan(500);
  });
});
