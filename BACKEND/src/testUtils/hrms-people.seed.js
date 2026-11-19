// HRMS Part A (People) + Part E (Branches) test fixtures — in-memory MongoDB only.
// Used by startHrmsPeopleTestStack.js (UI stack on :5206) and by
// src/hrms/__tests__/hrms-people.*.test.js (jest).
//
// Companies:
//   A, B        — normal companies (company separation)
//   R           — Rudraverse-style tenant, owner info@trinetratechnoworld.com
//   OFF         — plan with module_access.hrms = false
// Users in A / B / R (every password = Test@1234):
//   admin    CRM admin (Staff.admin) + HRMS role "admin" ["*"]
//   dir      Setup→Roles "HRMS Staff Directory" (View/Create/Edit/Delete) only — HRMS profile with NO HRMS role
//            (exactly what Setup > Staff creates today)
//   dirH     same CRM permission AND an HRMS role ["manage_users","view_staff","create_staff"]
//   dept     "HRMS Departments" full + HRMS role ["view_departments"]
//   desig    "HRMS Designations" full + HRMS role ["manage_designations"]
//   brView   "HRMS Branch Management" View(Global) only + HRMS role ["view_branches"]
//   brFull   "HRMS Branch Management" full + HRMS role [view/create/edit/delete_branches]
//   att      "HRMS Attendance" View(Global) + HRMS role ["view_attendance"]
//   emp      normal staff, no HRMS permission
//   sup      branch supervisor of "North <L>"
//   w1..w4   workers (w1,w2 in North, w3,w4 in South)
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const PASSWORD = "Test@1234";
const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW = { "View(Global)": true };

let phoneSeq = 0;
const nextPhone = (prefix = "9") => `${prefix}${String(800000000 + ++phoneSeq).slice(-9)}`;

async function ensureIndexes() {
  // Unique indexes are built in the background; build them now so duplicate
  // checks test the app and not a race in the test database.
  for (const name of mongoose.modelNames()) {
    try { await mongoose.model(name).init(); } catch { /* model without collection */ }
  }
}

function loadModels() {
  require("../models/QuotationType");
  return {
    Staff: require("../models/Staff"),
    Tenant: require("../models/Tenant"),
    SaasPlan: require("../models/SaasPlan"),
    User: require("../hrms/models/user_model"),
    HRole: require("../hrms/models/role_model"),
    Branch: require("../hrms/models/hrms_branch_model"),
    BranchType: require("../hrms/models/branch_type_model"),
    Department: require("../hrms/models/department_model"),
    Designation: require("../hrms/models/designation_model"),
  };
}

const crmToken = (staffId) => jwt.sign({ id: String(staffId), role: "staff" }, process.env.JWT_SECRET);
const hrmsToken = (userId) => jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET);

async function seedCompany(M, label, { ownerEmail, planId, domain = "hrms-people.test" } = {}) {
  const tenantId = new mongoose.Types.ObjectId();
  const lc = label.toLowerCase();
  await mongoose.connection.db.collection("tenants").insertOne({
    _id: tenantId, company_name: `People ${label}`, name: `People ${label}`, status: "active",
    ...(planId ? { plan_id: planId } : {}), createdAt: new Date(), updatedAt: new Date(),
  });
  const roles = {};
  const mkRole = async (key, permissions) => {
    roles[key] = await M.HRole.create({ role: key, label: key, permissions, tenant_id: tenantId });
    return roles[key];
  };
  await mkRole("admin", ["*"]);
  await mkRole("directory", ["manage_users", "view_staff", "create_staff"]);
  await mkRole("deptmgr", ["view_departments"]);
  await mkRole("desigmgr", ["manage_designations"]);
  await mkRole("branchview", ["view_branches"]);
  await mkRole("branchfull", ["view_branches", "create_branches", "edit_branches", "delete_branches"]);
  await mkRole("attendance", ["view_attendance"]);

  const users = {};
  const mk = async (key, { email, admin = false, perms = {}, hrmsRole = null, first, last, extra = {} } = {}) => {
    const em = email || `${key}.${lc}@${domain}`;
    const mobile = nextPhone();
    const hu = await M.User.create({
      name: `${first || key} ${last || label}`, email: em, password: PASSWORD, mobile,
      role: hrmsRole ? roles[hrmsRole]._id : undefined, tenant_id: tenantId, salaryAmount: 25000,
      employeeCode: `${label}-${key}`.toUpperCase(), ...extra,
    });
    const st = await M.Staff.create({
      firstname: first || key, lastname: last || label, email: em, password: PASSWORD, phonenumber: mobile,
      admin, active: true, tenant_id: tenantId, permissions: perms, hrms_user_id: hu._id, is_hrms_staff: !admin,
    });
    await M.User.updateOne({ _id: hu._id }, { $set: { staffId: st._id } });
    users[key] = { key, email: em, staffId: String(st._id), userId: String(hu._id), mobile, token: crmToken(st._id), hrmsToken: hrmsToken(hu._id) };
    return users[key];
  };

  await mk("admin", { email: ownerEmail, admin: true, hrmsRole: "admin", first: "Admin" });
  await mk("dir", { perms: { "HRMS Staff Directory": FULL } });
  await mk("dirH", { perms: { "HRMS Staff Directory": FULL }, hrmsRole: "directory" });
  await mk("dept", { perms: { "HRMS Departments": FULL }, hrmsRole: "deptmgr" });
  await mk("desig", { perms: { "HRMS Designations": FULL }, hrmsRole: "desigmgr" });
  await mk("brView", { perms: { "HRMS Branch Management": VIEW }, hrmsRole: "branchview" });
  await mk("brFull", { perms: { "HRMS Branch Management": FULL }, hrmsRole: "branchfull" });
  await mk("att", { perms: { "HRMS Attendance": VIEW }, hrmsRole: "attendance" });
  await mk("emp", {});
  await mk("sup", {});

  if (ownerEmail) await M.Tenant.updateOne({ _id: tenantId }, { $set: { owner_id: users.admin.staffId } });

  const btype = await M.BranchType.create({ name: `Retail ${label}`, tenant_id: tenantId });
  const north = await M.Branch.create({
    name: `North ${label}`, tenant_id: tenantId, branchType: btype._id, city: "Ahmedabad", state: "Gujarat", pincode: "380001",
    phone: "9876543210", latitude: 23.02, longitude: 72.57, radius: 500, geoFenceEnabled: true, supervisorIds: [users.sup.userId],
  });
  const south = await M.Branch.create({ name: `South ${label}`, tenant_id: tenantId, city: "Surat", state: "Gujarat", status: "Active" });
  const dept = await M.Department.create({ name: `Sales ${label}`, code: `SLS${label}`, tenant_id: tenantId });
  const desig = await M.Designation.create({ name: `Manager ${label}`, code: `MGR${label}`, level: 3, tenant_id: tenantId });

  for (const [i, br] of [[1, north], [2, north], [3, south], [4, south]]) {
    await mk(`w${i}`, { first: `Worker${i}`, extra: { hrmsBranchId: br._id, department: dept._id, designation: desig._id } });
  }
  await M.User.updateOne({ _id: users.sup.userId }, { $set: { hrmsBranchId: north._id } });

  return { label, tenantId: String(tenantId), roles, users, branches: { north, south }, branchType: btype, dept, desig };
}

async function seedPeople() {
  const M = loadModels();
  await ensureIndexes();
  const offPlan = await M.SaasPlan.create({ name: "People No-HRMS Plan", price: 0, module_access: { hrms: false } });
  const T = {};
  T.A = await seedCompany(M, "A");
  T.B = await seedCompany(M, "B");
  T.R = await seedCompany(M, "R", { ownerEmail: "info@trinetratechnoworld.com" });
  T.OFF = await seedCompany(M, "OFF", { planId: offPlan._id });
  return { T, M, PASSWORD };
}

// 1,000 extra staff for the performance phase (raw insert = fast).
async function seedBulkStaff(tenantId, n = 1000) {
  const M = loadModels();
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash(PASSWORD, 4);
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      name: `Perf Staff ${String(i).padStart(4, "0")}`, email: `perf${i}@perf.hrms-people.test`, password: hash,
      mobile: `7${String(100000000 + i)}`, tenant_id: new mongoose.Types.ObjectId(String(tenantId)), isActive: i % 10 !== 0,
      employeeCode: `PERF${i}`, salaryAmount: 20000 + i, createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date(),
    });
  }
  await M.User.collection.insertMany(docs);
  return n;
}

module.exports = { seedPeople, seedBulkStaff, ensureIndexes, PASSWORD, crmToken, hrmsToken, FULL, VIEW };
