// Setup > Staff (/api/staffs) — positive, negative, integration and permission tests.
// [+] positive, [-] negative, [I] integration / isolation, [P] permission, [S] HRMS sync.
// Each test states the CORRECT behaviour; a failing test is a bug found.
// In-memory MongoDB only — see src/testUtils/crmTestApp.js.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

jest.setTimeout(120000);

let A;
let B;
let admin;
let n = 0;
const nextStaff = (extra = {}) => {
  n += 1;
  return {
    firstname: "Test", lastname: `Staff${n}`, email: `setup.staff${n}@crm-test.local`,
    phonenumber: `96000000${String(n).padStart(2, "0")}`, password: "Test@12345", ...extra,
  };
};
const User = () => require("../../hrms/models/user_model");
const Staff = () => require("../../models/Staff");
const idOf = (r) => r.body?._id;

beforeAll(async () => {
  await start([
    ["/api/staffs", "routes/staff_routes"],
    ["/api/auth", "routes/auth_routes"],
    ["/api/hrms", "hrms/routes/index"],
  ]);
  require("../../models/QuotationType"); // HRMS branch populate needs it registered
  A = await seedCompany("A", ["Staff"]);
  B = await seedCompany("B", ["Staff"]);
  admin = client(A.admin.token);
});
afterAll(stop);

describe("Positive: create / list / view / edit / delete", () => {
  let id;
  test("[+] create with required fields only", async () => {
    const r = await admin.post("/api/staffs", nextStaff());
    expect(r.status).toBe(201);
    id = idOf(r);
  });
  test("[+] new staff appears in the list without the password", async () => {
    const r = await admin.get("/api/staffs");
    const row = r.body.find((s) => String(s._id) === String(id));
    expect(row).toBeDefined();
    expect(row.password).toBeUndefined();
  });
  test("[+] create with every section filled (employment, bank, salary, legal)", async () => {
    const r = await admin.post("/api/staffs", nextStaff({
      gender: "Female", dob: "1995-05-10", bloodGroup: "O+", education: "MBA", totalExperience: "5 Years",
      residentialPhone: "9811111111", emergencyContact: { name: "Asha", phone: "9822222222", relation: "Sister" },
      address: { current: "CG Road", permanent: "Rajkot" }, joiningDate: "2024-04-01", employmentType: "permanent",
      attendanceRequired: true, weeklyHolidays: ["Sun"],
      bankInfo: { bankName: "HDFC", ifscCode: "HDFC0001234", accountNumber: "123456789012", accountName: "Test Staff" },
      payType: "Monthly", salaryAmount: 30000,
      salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 }, pf: { isIncluded: true, mode: "fixed_monthly" } },
      legalDocuments: { panNumber: "ABCDE1234F", aadhaarNumber: "234123412341" },
      skype: "test.skype", default_language: "english", direction: "ltr", email_signature: "Regards",
    }));
    expect(r.status).toBe(201);
    const view = await admin.get(`/api/staffs/${idOf(r)}`);
    expect(view.status).toBe(200);
    expect(view.body.bankInfo?.ifscCode).toBe("HDFC0001234");
    expect(view.body.legalDocuments?.panNumber).toBe("ABCDE1234F");
    expect(view.body.salaryAmount).toBe(30000);
    expect(view.body.salaryConfig?.basic?.value).toBe(18000);
  });
  test("[+] edit name and mobile", async () => {
    const r = await admin.put(`/api/staffs/${id}`, { firstname: "Edited", phonenumber: "9600000999" });
    expect(r.status).toBe(200);
    expect(r.body.firstname).toBe("Edited");
  });
  test("[+] deactivate then reactivate", async () => {
    expect((await admin.put(`/api/staffs/${id}`, { active: false })).status).toBe(200);
    expect((await Staff().findById(id)).active).toBe(false);
    expect((await admin.put(`/api/staffs/${id}`, { active: true })).status).toBe(200);
  });
  test("[+] delete", async () => {
    expect((await admin.del(`/api/staffs/${id}`)).status).toBe(200);
    expect(await Staff().findById(id)).toBeNull();
  });
  test("[+] blank password generates a temporary one and returns it once", async () => {
    const r = await admin.post("/api/staffs", nextStaff({ password: "" }));
    expect(r.status).toBe(201);
    expect(typeof r.body.generatedPassword).toBe("string");
  });
});

describe("Negative: identity fields", () => {
  test("[-] missing first name → 400 with a clear message (not 500)", async () => {
    expect((await admin.post("/api/staffs", nextStaff({ firstname: "" }))).status).toBe(400);
  });
  test("[-] first name of only spaces → 400", async () => {
    expect((await admin.post("/api/staffs", nextStaff({ firstname: "   " }))).status).toBe(400);
  });
  test("[-] 500-character first name → 400", async () => {
    expect((await admin.post("/api/staffs", nextStaff({ firstname: "A".repeat(500) }))).status).toBe(400);
  });
  test("[-] HTML/script in first name is not stored as-is", async () => {
    const r = await admin.post("/api/staffs", nextStaff({ firstname: "<script>alert(1)</script>" }));
    const saved = r.status === 201 ? (await Staff().findById(idOf(r))).firstname : "";
    expect(saved.includes("<script>")).toBe(false);
  });
  for (const bad of ["abc", "abc@", "@x.com", "a@b", "a b@c.com"]) {
    test(`[-] email "${bad}" → 400`, async () => {
      expect((await admin.post("/api/staffs", nextStaff({ email: bad }))).status).toBe(400);
    });
  }
  test("[-] missing email → 400 (not 500)", async () => {
    expect((await admin.post("/api/staffs", nextStaff({ email: "" }))).status).toBe(400);
  });
  for (const [label, phone] of [["9 digits", "960000001"], ["11 digits", "96000000012"], ["letters", "96000abcde"], ["empty", ""]]) {
    test(`[-] mobile ${label} → 400`, async () => {
      expect((await admin.post("/api/staffs", nextStaff({ phonenumber: phone }))).status).toBe(400);
    });
  }
  test("[+] mobile with +91 and spaces is accepted and stored as 10 digits", async () => {
    const r = await admin.post("/api/staffs", nextStaff({ phonenumber: "+91 96000 77777" }));
    expect(r.status).toBe(201);
    expect((await Staff().findById(idOf(r))).phonenumber).toBe("9600077777");
  });
  test("[-] duplicate email in the same company → 400", async () => {
    const s = nextStaff();
    await admin.post("/api/staffs", s);
    expect((await admin.post("/api/staffs", { ...s, phonenumber: "9600055555" })).status).toBe(400);
  });
  test("[-] duplicate email in another company → 400 (one email = one account)", async () => {
    const s = nextStaff();
    await admin.post("/api/staffs", s);
    expect((await client(B.admin.token).post("/api/staffs", { ...s, phonenumber: "9600066666" })).status).toBe(400);
  });
  test("[-] duplicate mobile → 400", async () => {
    const s = nextStaff();
    await admin.post("/api/staffs", s);
    expect((await admin.post("/api/staffs", nextStaff({ phonenumber: s.phonenumber }))).status).toBe(400);
  });
  for (const weak of ["1", "123", "password"]) {
    test(`[-] weak password "${weak}" → 400`, async () => {
      expect((await admin.post("/api/staffs", nextStaff({ password: weak }))).status).toBe(400);
    });
  }
  test("[-] edit: email changed to 'abc' → 400", async () => {
    const r = await admin.post("/api/staffs", nextStaff());
    expect((await admin.put(`/api/staffs/${idOf(r)}`, { email: "abc" })).status).toBe(400);
  });
  test("[-] edit: first name cleared → 400 (not 500)", async () => {
    const r = await admin.post("/api/staffs", nextStaff());
    expect((await admin.put(`/api/staffs/${idOf(r)}`, { firstname: "" })).status).toBe(400);
  });
  test("[-] edit: password '1' → 400", async () => {
    const r = await admin.post("/api/staffs", nextStaff());
    expect((await admin.put(`/api/staffs/${idOf(r)}`, { password: "1" })).status).toBe(400);
  });
  test("[-] invalid id 'abc' → 400/404, never 500", async () => {
    expect([400, 404]).toContain((await admin.get("/api/staffs/abc")).status);
    expect([400, 404]).toContain((await admin.put("/api/staffs/abc", { firstname: "x" })).status);
    expect([400, 404]).toContain((await admin.del("/api/staffs/abc")).status);
  });
  test("[-] body tenant_id is ignored (staff stays in the creator's company)", async () => {
    const r = await admin.post("/api/staffs", nextStaff({ tenant_id: String(B.tenantId) }));
    expect(String((await Staff().findById(idOf(r))).tenant_id)).toBe(String(A.tenantId));
  });
  test("[-] no token → 401, forged token → 401", async () => {
    expect((await client("").get("/api/staffs")).status).toBe(401);
    expect((await client("bad.token.here").get("/api/staffs")).status).toBe(401);
  });
});

describe("Negative: HRMS-side fields entered on Setup > Staff", () => {
  const createAndRead = async (extra) => {
    const r = await admin.post("/api/staffs", nextStaff(extra));
    const staff = r.status === 201 ? await Staff().findById(idOf(r)) : null;
    const user = staff?.hrms_user_id ? await User().findById(staff.hrms_user_id).populate("salaryStructureId") : null;
    return { r, staff, user };
  };
  test("[-] negative Base Salary → 400 (not 'saved with warning')", async () => {
    const { r } = await createAndRead({ salaryAmount: -5000 });
    expect(r.status).toBe(400);
  });
  test("[-] Base Salary 'abc' → 400", async () => {
    const { r } = await createAndRead({ salaryAmount: "abc" });
    expect(r.status).toBe(400);
  });
  test("[-] negative Basic in salary breakdown → 400 (not silently 0)", async () => {
    const { r } = await createAndRead({ salaryConfig: { basic: { value: -18000 } } });
    expect(r.status).toBe(400);
  });
  test("[-] HRA 'abc' → 400 (not silently 0)", async () => {
    const { r } = await createAndRead({ salaryConfig: { basic: { value: 10000 }, hra: { value: "abc" } } });
    expect(r.status).toBe(400);
  });
  test("[-] Basic + HRA larger than Base Salary (CTC) → 400", async () => {
    const { r } = await createAndRead({ salaryAmount: 20000, salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 } } });
    expect(r.status).toBe(400);
  });
  test("[-] PAN 'XYZ' → 400", async () => {
    expect((await createAndRead({ legalDocuments: { panNumber: "XYZ" } })).r.status).toBe(400);
  });
  test("[-] PAN lowercase 'abcde1234f' is stored uppercase or rejected", async () => {
    const { r, user } = await createAndRead({ legalDocuments: { panNumber: "abcde1234f" } });
    expect(r.status === 400 || user?.legalDocuments?.panNumber === "ABCDE1234F").toBe(true);
  });
  test("[-] Aadhaar '123' → 400", async () => {
    expect((await createAndRead({ legalDocuments: { aadhaarNumber: "123" } })).r.status).toBe(400);
  });
  test("[-] IFSC 'ABC' → 400", async () => {
    expect((await createAndRead({ bankInfo: { ifscCode: "ABC" } })).r.status).toBe(400);
  });
  test("[-] bank account number 'abc' → 400", async () => {
    expect((await createAndRead({ bankInfo: { accountNumber: "abc" } })).r.status).toBe(400);
  });
  test("[-] future date of birth → 400", async () => {
    expect((await createAndRead({ dob: "2099-01-01" })).r.status).toBe(400);
  });
  test("[-] joining date before date of birth → 400", async () => {
    expect((await createAndRead({ dob: "2000-01-01", joiningDate: "1990-01-01" })).r.status).toBe(400);
  });
  test("[-] residential phone 'abc' → 400", async () => {
    expect((await createAndRead({ residentialPhone: "abc" })).r.status).toBe(400);
  });
  test("[-] emergency contact phone of 5 digits → 400", async () => {
    expect((await createAndRead({ emergencyContact: { name: "X", phone: "12345", relation: "Friend" } })).r.status).toBe(400);
  });
  test("[-] branch id from another company is not linked", async () => {
    const bBranch = await mongoose.connection.db.collection("hrmsbranches").insertOne({ name: "B Branch", tenant_id: B.tenantId, status: "Active" });
    const { r, user } = await createAndRead({ hrmsBranchId: String(bBranch.insertedId) });
    expect(r.status === 400 || String(user?.hrmsBranchId || "") !== String(bBranch.insertedId)).toBe(true);
  });
  test("[-] invalid department id 'xyz' → 400 (not 500, not silently dropped)", async () => {
    expect((await createAndRead({ department: "xyz" })).r.status).toBe(400);
  });
  test("[-] invalid employment type 'Gig' → 400", async () => {
    expect((await createAndRead({ employmentType: "Gig" })).r.status).toBe(400);
  });
});

describe("[S] Setup > Staff ↔ HRMS > Staff Directory stay in sync", () => {
  let staffId;
  let userId;
  test("[S] create mirrors an HRMS profile with the same name, email, mobile, salary", async () => {
    const s = nextStaff({ salaryAmount: 25000 });
    const r = await admin.post("/api/staffs", s);
    staffId = idOf(r);
    const staff = await Staff().findById(staffId);
    expect(staff.hrms_user_id).toBeTruthy();
    userId = staff.hrms_user_id;
    const u = await User().findById(userId);
    expect(u.email).toBe(s.email);
    expect(u.mobile).toBe(s.phonenumber);
    expect(u.salaryAmount).toBe(25000);
    expect(String(u.tenant_id)).toBe(String(A.tenantId));
    expect(r.body.hrmsSyncWarning).toBeUndefined();
  });
  test("[S] edit name / mobile / salary in Setup → HRMS profile updated", async () => {
    await admin.put(`/api/staffs/${staffId}`, { firstname: "Synced", lastname: "Name", phonenumber: "9600012345", salaryAmount: 27000 });
    const u = await User().findById(userId);
    expect(u.name).toBe("Synced Name");
    expect(u.mobile).toBe("9600012345");
    expect(u.salaryAmount).toBe(27000);
  });
  test("[S] edit branch in Setup → HRMS profile branch updated", async () => {
    const br = await mongoose.connection.db.collection("hrmsbranches").insertOne({ name: "A Branch", tenant_id: A.tenantId, status: "Active" });
    await admin.put(`/api/staffs/${staffId}`, { hrmsBranchId: String(br.insertedId) });
    expect(String((await User().findById(userId)).hrmsBranchId)).toBe(String(br.insertedId));
  });
  test("[S] edit in HRMS Staff Directory → Setup > Staff name and mobile updated", async () => {
    const hrms = client(jwt.sign({ id: String(A.admin.id) }, process.env.JWT_SECRET));
    const r = await hrms.put(`/api/hrms/users/${userId}`, { name: "From Hrms", mobile: "9600054321" });
    expect(r.status).toBe(200);
    const s = await Staff().findById(staffId);
    expect(`${s.firstname} ${s.lastname}`).toBe("From Hrms");
    expect(s.phonenumber).toBe("9600054321");
  });
  test("[S] deactivate in Setup → HRMS profile inactive", async () => {
    await admin.put(`/api/staffs/${staffId}`, { active: false });
    expect((await User().findById(userId)).isActive).toBe(false);
  });
  test("[S] delete in Setup → HRMS profile deactivated (history kept)", async () => {
    await admin.put(`/api/staffs/${staffId}`, { active: true });
    await admin.del(`/api/staffs/${staffId}`);
    const u = await User().findById(userId);
    expect(u).not.toBeNull();
    expect(u.isActive).toBe(false);
  });
  test("[S] a negative salary does not leave Staff and HRMS out of sync", async () => {
    const r = await admin.post("/api/staffs", nextStaff({ salaryAmount: -1 }));
    if (r.status === 201) {
      const s = await Staff().findById(idOf(r));
      expect(s.hrms_user_id).toBeTruthy(); // fails = Staff saved but no HRMS profile
    } else {
      expect(r.status).toBe(400);
    }
  });
});

describe("[I] Company isolation", () => {
  let aStaff;
  beforeAll(async () => {
    aStaff = idOf(await admin.post("/api/staffs", nextStaff()));
  });
  test("[I] company B's list never shows company A's staff", async () => {
    const r = await client(B.admin.token).get("/api/staffs");
    expect(r.body.some((s) => String(s._id) === String(aStaff))).toBe(false);
  });
  test("[I] company B cannot open company A's staff by id", async () => {
    expect([403, 404]).toContain((await client(B.admin.token).get(`/api/staffs/${aStaff}`)).status);
  });
  test("[I] company B cannot edit company A's staff", async () => {
    expect([403, 404]).toContain((await client(B.admin.token).put(`/api/staffs/${aStaff}`, { firstname: "Hacked" })).status);
    expect((await Staff().findById(aStaff)).firstname).not.toBe("Hacked");
  });
  test("[I] company B cannot delete company A's staff", async () => {
    expect([403, 404]).toContain((await client(B.admin.token).del(`/api/staffs/${aStaff}`)).status);
    expect(await Staff().findById(aStaff)).not.toBeNull();
  });
  test("[I] assignable list (task pickers) shows only own company", async () => {
    const r = await client(B.admin.token).get("/api/staffs/assignable");
    expect(r.body.some((s) => String(s._id) === String(aStaff))).toBe(false);
  });
});

describe("[P] Permissions", () => {
  test("[P] view-only staff cannot create staff", async () => {
    expect((await client(A.viewOnly.token).post("/api/staffs", nextStaff())).status).toBe(403);
  });
  test("[P] view-only staff cannot edit another staff member", async () => {
    const id = idOf(await admin.post("/api/staffs", nextStaff()));
    expect((await client(A.viewOnly.token).put(`/api/staffs/${id}`, { firstname: "ByViewer" })).status).toBe(403);
  });
  test("[P] view-only staff cannot delete staff", async () => {
    const id = idOf(await admin.post("/api/staffs", nextStaff()));
    expect((await client(A.viewOnly.token).del(`/api/staffs/${id}`)).status).toBe(403);
  });
  test("[P] view-only staff cannot import staff", async () => {
    expect((await client(A.viewOnly.token).post("/api/staffs/import", [nextStaff()])).status).toBe(403);
  });
  test("[P] staff with no Staff permission cannot list staff", async () => {
    expect((await client(A.noAccess.token).get("/api/staffs")).status).toBe(403);
  });
  test("[P] a non-admin cannot make themselves admin", async () => {
    await client(A.noAccess.token).put(`/api/staffs/${A.noAccess.id}`, { admin: true });
    expect((await Staff().findById(A.noAccess.id)).admin).toBe(false);
  });
  test("[P] a non-admin cannot give themselves permissions on their own profile", async () => {
    await client(A.noAccess.token).put(`/api/staffs/${A.noAccess.id}`, {
      permissions: { Staff: { "View(Global)": true, Create: true, Edit: true, Delete: true } },
    });
    const me = await Staff().findById(A.noAccess.id);
    const perms = me.permissions instanceof Map ? Object.fromEntries(me.permissions) : (me.permissions || {});
    expect(perms.Staff).toBeUndefined();
  });
  test("[P] a non-admin cannot change their own role", async () => {
    const roleId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("roles").insertOne({ _id: roleId, name: "Boss", tenant_id: A.tenantId, permissions: {} });
    await client(A.noAccess.token).put(`/api/staffs/${A.noAccess.id}`, { role: String(roleId) });
    expect(String((await Staff().findById(A.noAccess.id)).role || "")).not.toBe(String(roleId));
  });
  test("[P] a full-access (non-admin) staff cannot grant permissions they don't have", async () => {
    const r = await client(A.full.token).post("/api/staffs", nextStaff({
      permissions: { Invoices: { "View(Global)": true, Create: true, Edit: true, Delete: true } },
    }));
    const s = r.status === 201 ? await Staff().findById(idOf(r)) : null;
    const perms = s ? (s.permissions instanceof Map ? Object.fromEntries(s.permissions) : s.permissions) : {};
    expect(r.status === 403 || !perms.Invoices).toBe(true);
  });
});

// Destructive delete checks run in their own throwaway company D so a successful
// (buggy) delete of the admin cannot break the other tests.
describe("[P] Deleting admins (separate company)", () => {
  let D;
  beforeAll(async () => { D = await seedCompany("D", ["Staff"]); });
  test("[P] a full-access staff cannot delete the company admin", async () => {
    expect([403, 400]).toContain((await client(D.full.token).del(`/api/staffs/${D.admin.id}`)).status);
  });
  test("[P] an admin cannot delete their own account (would lock the company out)", async () => {
    const D2 = await seedCompany("D2", ["Staff"]);
    expect([400, 403]).toContain((await client(D2.admin.token).del(`/api/staffs/${D2.admin.id}`)).status);
  });
});

describe("[I] Login after create / deactivate", () => {
  test("[I] a newly created staff member can log in", async () => {
    const s = nextStaff();
    await admin.post("/api/staffs", s);
    const r = await client("").post("/api/auth/login", { email: s.email, password: s.password });
    expect(r.status).toBe(200);
    expect(r.body.token || r.body.user).toBeTruthy();
  });
  test("[I] an inactive staff member cannot log in", async () => {
    const s = nextStaff();
    const id = idOf(await admin.post("/api/staffs", s));
    await admin.put(`/api/staffs/${id}`, { active: false });
    expect((await client("").post("/api/auth/login", { email: s.email, password: s.password })).status).toBe(401);
  });
  test("[I] the wrong password is rejected", async () => {
    const s = nextStaff();
    await admin.post("/api/staffs", s);
    expect((await client("").post("/api/auth/login", { email: s.email, password: "wrong-pass" })).status).toBe(401);
  });
});

describe("[I] Plan staff limit (PLAN_LIMITS_ENFORCE=on)", () => {
  let C;
  beforeAll(async () => {
    process.env.PLAN_LIMITS_ENFORCE = "on";
    require("../../models/SaasPlan"); // registered at startup in the real server; populate needs it
    C = await seedCompany("C", ["Staff"]); // admin + viewer + editor + nobody = 4 active staff
    const planId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("saasplans").insertOne({ _id: planId, name: "Tiny", price: 0, features: { max_users: 5 } });
    await mongoose.connection.db.collection("tenants").updateOne({ _id: C.tenantId }, { $set: { plan_id: planId } });
  });
  afterAll(() => { delete process.env.PLAN_LIMITS_ENFORCE; });
  test("[+] staff within the limit can be added", async () => {
    expect((await client(C.admin.token).post("/api/staffs", nextStaff())).status).toBe(201);
  });
  test("[-] one more than the plan allows is refused (403 PLAN_LIMIT_REACHED)", async () => {
    const r = await client(C.admin.token).post("/api/staffs", nextStaff());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PLAN_LIMIT_REACHED");
  });
  test("[-] the import cannot be used to go over the limit", async () => {
    const r = await client(C.admin.token).post("/api/staffs/import", [nextStaff(), nextStaff()]);
    const count = await Staff().countDocuments({ tenant_id: C.tenantId, active: { $ne: false } });
    expect(count).toBeLessThanOrEqual(5);
    expect(r.status).toBeLessThan(500);
  });
  test("[-] reactivating a staff member when full is refused", async () => {
    const id = (await Staff().findOne({ tenant_id: C.tenantId, admin: false }))._id;
    await client(C.admin.token).put(`/api/staffs/${id}`, { active: false });
    await client(C.admin.token).post("/api/staffs", nextStaff()); // fills the freed seat
    expect((await client(C.admin.token).put(`/api/staffs/${id}`, { active: true })).status).toBe(403);
  });
});

describe("Import", () => {
  test("[+] import 3 valid rows creates 3 staff", async () => {
    const rows = [nextStaff(), nextStaff(), nextStaff()];
    const r = await admin.post("/api/staffs/import", rows);
    expect(r.status).toBeLessThan(300);
    for (const row of rows) expect(await Staff().exists({ email: row.email })).toBeTruthy();
  });
  test("[-] empty import → 400", async () => {
    expect((await admin.post("/api/staffs/import", [])).status).toBe(400);
  });
  test("[-] rows with a bad email / bad mobile are skipped, not saved", async () => {
    const bad = [nextStaff({ email: "not-an-email" }), nextStaff({ phonenumber: "12" })];
    await admin.post("/api/staffs/import", bad);
    expect(await Staff().exists({ email: "not-an-email" })).toBeFalsy();
    expect(await Staff().exists({ email: bad[1].email })).toBeFalsy();
  });
  test("[-] the same file imported twice does not create duplicates", async () => {
    const rows = [nextStaff()];
    await admin.post("/api/staffs/import", rows);
    await admin.post("/api/staffs/import", rows);
    expect(await Staff().countDocuments({ email: rows[0].email })).toBe(1);
  });
  test("[-] a sheet cannot grant admin rights", async () => {
    const row = nextStaff({ admin: true });
    await admin.post("/api/staffs/import", [row]);
    const s = await Staff().findOne({ email: row.email });
    expect(s?.admin || false).toBe(false);
  });
});

describe("Double submit", () => {
  test("[-] two identical create requests at the same time create only one staff", async () => {
    const s = nextStaff();
    const [r1, r2] = await Promise.all([admin.post("/api/staffs", s), admin.post("/api/staffs", s)]);
    expect([r1.status, r2.status].filter((x) => x === 201).length).toBe(1);
    expect(await Staff().countDocuments({ email: s.email })).toBe(1);
  });
});

// Salary entered on Setup > Staff → the payslip HRMS payroll produces from it.
describe("[C] Salary calculations (Setup > Staff salary → payroll)", () => {
  const hrmsAdmin = () => client(jwt.sign({ id: String(A.admin.id) }, process.env.JWT_SECRET));
  const payslipFor = async (extra, { month = 9, year = 2026, days = 30 } = {}) => {
    const r = await admin.post("/api/staffs", nextStaff(extra));
    const userId = String((await Staff().findById(idOf(r))).hrms_user_id);
    for (let d = 1; d <= days; d++) {
      const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      await hrmsAdmin().patch("/api/hrms/attendance/admin-correct", { userId, date, statusOverride: "Full Day" });
    }
    await hrmsAdmin().post("/api/hrms/payroll/generate", { month, year });
    const PayrollRecord = require("../../hrms/models/payroll_record_model");
    return PayrollRecord.findOne({ employeeId: userId, month, year });
  };
  const ded = (rec, label) => (rec?.deductions || []).find((d) => d.label === label)?.amount || 0;

  test("[C] Basic 18,000 + HRA 12,000, full month → gross 30,000", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 } } });
    expect(rec?.grossSalary).toBe(30000);
  });
  test("[C] PF fixed monthly, no amount → 12% of Basic 18,000 = 2,160", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 }, pf: { isIncluded: true, mode: "fixed_monthly" } } });
    expect(ded(rec, "PF (Employee)")).toBe(2160);
  });
  test("[C] PF per day ₹20 × 30 paid days = 600", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 }, pf: { isIncluded: true, mode: "per_day", value: 20 } } });
    expect(ded(rec, "PF (Employee)")).toBe(600);
  });
  test("[C] ESIC 0.75% of gross 18,000 = 135", async () => {
    const rec = await payslipFor({ salaryAmount: 18000, salaryConfig: { basic: { value: 18000 }, esic: { isIncluded: true } } });
    expect(ded(rec, "ESIC")).toBe(135);
  });
  test("[C] statutory: no ESIC when gross is above ₹21,000", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 30000 }, esic: { isIncluded: true } } });
    expect(ded(rec, "ESIC")).toBe(0);
  });
  test("[C] net = gross − all deductions, never negative", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 18000 }, hra: { value: 12000 }, pf: { isIncluded: true, mode: "fixed_monthly" }, professionalTax: { value: 200 } } });
    const total = (rec.deductions || []).reduce((s, d) => s + d.amount, 0);
    expect(Math.abs(rec.netSalary - (rec.grossSalary - total))).toBeLessThanOrEqual(1);
    expect(rec.netSalary).toBeGreaterThanOrEqual(0);
  });
  test("[C] half month present (15 of 30 days) → about half the gross", async () => {
    const rec = await payslipFor({ salaryAmount: 30000, salaryConfig: { basic: { value: 30000 } } }, { month: 6, days: 15 });
    expect(rec.grossSalary).toBeGreaterThanOrEqual(14000);
    expect(rec.grossSalary).toBeLessThanOrEqual(16000);
  });
});
