// Shared in-memory setup for the Goals module tests (05-goals.md).
// Tenant A: admin, "Goals view only", Goals full (no Staff perm), no Goals perm,
// 3 pickable staff, 2 contract types, 30 goals. Tenant B: own staff + 3 goals.
// Tenant C: plan with module_access.goals = false.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedCompany, client } = require("./crmTestApp");

const GOAL_TYPES = [
  "total_income", "invoiced_amount", "convert_leads", "customer_num_exclude",
  "customer_num_include", "contracts_by_type_added", "contracts_by_type_start", "estimates_conversion",
];

const XSS = "<script>alert(1)</script>";
const N = (n) => "a".repeat(n);
// Field negatives shared by goals.negative and goals.tenants. [field, label, value, "reject"|"accept"|"ignore"].
// "ignore" = request succeeds but the server does not store the client's value.
// __B_STAFF__ / __B_CT__ = a staff member / contract type of ANOTHER tenant.
const deletedStaffId = "64b0000000000000000000dd";
const FIELD_CASES = [
  ["subject", "empty", "", "reject"],
  ["subject", "spaces only", "   ", "reject"],
  ["subject", "missing", undefined, "reject"],
  ["subject", "1 char", "x", "accept"],
  ["subject", "500 chars (max 255)", N(500), "reject"],
  ["subject", "10,000 chars", N(10000), "reject"],
  ["subject", "<script> (stored raw; React escapes on render)", XSS, "accept"],
  ["subject", "emoji", "Goal 🎯🚀", "accept"],
  ["goal_type", "missing", undefined, "reject"],
  ["goal_type", "\"\"", "", "reject"],
  ["goal_type", "\"xyz\"", "xyz", "reject"],
  ["goal_type", "123", 123, "reject"],
  ["goal_type", "null", null, "reject"],
  ["staff_member", "missing", undefined, "reject"],
  ["staff_member", "\"abc\"", "abc", "reject"],
  ["staff_member", "deleted / non-existent staff id", deletedStaffId, "reject"],
  ["staff_member", "Tenant B staff id", "__B_STAFF__", "reject"],
  ["achievement", "0", "0", "reject"],
  ["achievement", "-100", "-100", "reject"],
  ["achievement", "1.5", "1.5", "accept"],
  ["achievement", "1e15", "1e15", "accept"],
  ["achievement", "\"e\"", "e", "reject"],
  ["achievement", "empty", "", "reject"],
  ["achievement", "\"abc\"", "abc", "reject"],
  ["achievement", "{}", {}, "reject"],
  ["achievement", "[]", [], "reject"],
  ["start_date", "missing", undefined, "reject"],
  ["start_date", "\"2026-02-30\"", "2026-02-30", "reject"],
  ["start_date", "\"abc\"", "abc", "reject"],
  ["start_date", "year 1900 (outside 2000-2100)", "1900-01-01", "reject"],
  ["start_date", "year 9999 (after end date)", "9999-01-01", "reject"],
  ["end_date", "missing", undefined, "reject"],
  ["end_date", "before start date", "2026-10-01", "reject"],
  ["end_date", "same day as start date", "2026-11-01", "accept"],
  ["end_date", "\"abc\"", "abc", "reject"],
  ["description", "10,000 chars (max 5000)", N(10000), "reject"],
  ["description", "<img onerror> (stored raw; React escapes)", "<img src=x onerror=alert(1)>", "accept"],
  ["notify_on_achieve", "\"yes\"", "yes", "reject"],
  ["notify_on_achieve", "1", 1, "reject"],
  ["notify_on_achieve", "null", null, "reject"],
  ["notify_on_fail", "\"yes\"", "yes", "reject"],
  ["notify_on_fail", "1", 1, "reject"],
  ["notify_on_fail", "null", null, "reject"],
  ["progress", "150 (client must not set)", 150, "ignore"],
  ["progress", "-10", -10, "ignore"],
  ["progress", "\"abc\"", "abc", "ignore"],
  ["contract_type", "Tenant B contract type", "__B_CT__", "reject"],
  ["contract_type", "\"abc\"", "abc", "reject"],
];

const tokenFor = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET);

async function boot() {
  const { uri, baseUrl } = await start([
    ["/api", "testUtils/planModuleGateOnly"],
    ["/api/goals", "routes/goal_routes"],
    ["/api/staff", "routes/staff_routes"],
  ]);
  const Goal = require("../models/Goal");
  const ContractType = require("../models/ContractType");
  const Staff = require("../models/Staff");
  const SaasPlan = require("../models/SaasPlan");
  const db = mongoose.connection.db;

  const A = await seedCompany("A", ["Goals"]);
  const B = await seedCompany("B", ["Goals"]);

  const mkStaff = async (tenantId, first, last) =>
    Staff.create({ firstname: first, lastname: last, email: `${first}.${last}@crm-test.local`.toLowerCase(), password: "x", active: true, tenant_id: tenantId });
  A.pick = [await mkStaff(A.tenantId, "Pick", "One"), await mkStaff(A.tenantId, "Pick", "Two"), await mkStaff(A.tenantId, "Pick", "Three")];
  B.pick = [await mkStaff(B.tenantId, "Bee", "Staff")];

  A.contractTypes = await ContractType.create([{ name: "AMC", tenant_id: A.tenantId }, { name: "Service", tenant_id: A.tenantId }]);
  B.contractTypes = await ContractType.create([{ name: "B Secret Type", tenant_id: B.tenantId }]);

  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const goalsA = [];
  for (let i = 0; i < 30; i++) {
    const ended = i % 3 === 0;
    goalsA.push({
      subject: `Seed Goal ${String(i + 1).padStart(2, "0")}`,
      staff_member: A.pick[i % 3]._id,
      achievement: String(1000 * (i + 1)),
      start_date: new Date(now - (ended ? 60 : 5) * day),
      end_date: new Date(now + (ended ? -30 : 30) * day),
      goal_type: GOAL_TYPES[i % 8],
      tenant_id: A.tenantId,
    });
  }
  A.goals = await Goal.create(goalsA);
  B.goals = await Goal.create([1, 2, 3].map((n) => ({
    subject: `B Secret Goal ${n}`, staff_member: B.pick[0]._id, achievement: "500",
    start_date: new Date(now), end_date: new Date(now + 10 * day), goal_type: "total_income", tenant_id: B.tenantId,
  })));

  // Tenant C: plan without goals.
  const plan = await SaasPlan.create({ name: "No Goals Plan", price: 0, module_access: { goals: false } });
  const tenantC = new mongoose.Types.ObjectId();
  await db.collection("tenants").insertOne({ _id: tenantC, company_name: "Company C", status: "active", plan_id: plan._id });
  const adminC = await Staff.create({ firstname: "admin", lastname: "C", email: "admin.c@crm-test.local", password: "x", active: true, admin: true, tenant_id: tenantC });
  const C = { tenantId: tenantC, admin: { id: adminC._id, token: tokenFor(adminC._id) } };

  // Non-superadmin staff with no tenant (Goals view) — tenant filter is skipped for them.
  const orphan = await Staff.create({ firstname: "Orphan", lastname: "NoTenant", email: "orphan@crm-test.local", password: "x", active: true, admin: false, tenant_id: null, permissions: { Goals: { "View(Global)": true } } });
  const O = { id: orphan._id, token: tokenFor(orphan._id) };

  return { uri, baseUrl, A, B, C, O, Goal, Staff, ContractType, client, GOAL_TYPES };
}

// A valid goal body for tenant A.
const validBody = (A, extra = {}) => ({
  subject: "Valid goal",
  goal_type: "total_income",
  staff_member: String(A.pick[0]._id),
  achievement: "50000",
  start_date: "2026-11-01",
  end_date: "2026-12-31",
  description: "desc",
  notify_on_achieve: true,
  notify_on_fail: true,
  ...extra,
});

// Fake copies of the real tenants (test data only). Pilot logic elsewhere keys off these
// admin emails, so Rudraverse/Trinetra and Ekagra use the real ones.
const TENANTS = [
  { key: "BeOnTime", email: "admin@beontime.test" },
  { key: "CitySmile", email: "admin@citysmile.test" },
  { key: "Kiran", email: "admin@kiran.test" },
  { key: "OffixNest", email: "admin@offixnest.test" },
  { key: "Rudraverse", email: "info@trinetratechnoworld.com" },
  { key: "Ekagra", email: "ekagraengineering@gmail.com" },
];

// Every tenant in TENANTS (plan with goals on) + "NoGoalsPlan" (goals:false). Each gets an
// admin, a Goals view-only staff, a no-Goals staff, 3 staff members, 2 contract types, 5 goals.
async function bootTenants() {
  const { uri, baseUrl } = await start([
    ["/api", "testUtils/planModuleGateOnly"],
    ["/api/goals", "routes/goal_routes"],
    ["/api/staff", "routes/staff_routes"],
  ]);
  return { uri, baseUrl, ...(await seedAllTenants()), client };
}

// Seeds the tenants above into the already-connected in-memory DB. password is stored
// as given (pass a bcrypt hash when the real /api/auth/login must accept it).
async function seedAllTenants({ password = "x" } = {}) {
  const Goal = require("../models/Goal");
  const ContractType = require("../models/ContractType");
  const Staff = require("../models/Staff");
  const SaasPlan = require("../models/SaasPlan");
  const db = mongoose.connection.db;
  const fullPlan = await SaasPlan.create({ name: "Full Plan", price: 0, module_access: { goals: true } });
  const noGoalsPlan = await SaasPlan.create({ name: "No Goals Plan", price: 0, module_access: { goals: false } });

  const T = {};
  for (const { key, email, plan } of [...TENANTS, { key: "NoGoalsPlan", email: "admin@nogoals.test", plan: noGoalsPlan }]) {
    const tenantId = new mongoose.Types.ObjectId();
    await db.collection("tenants").insertOne({ _id: tenantId, company_name: key, status: "active", plan_id: (plan || fullPlan)._id });
    const mk = async (first, extra = {}) => {
      const s = await Staff.create({ firstname: first, lastname: key, email: first === "Admin" ? email : `${first}.${key}@crm-test.local`.toLowerCase(), password, active: true, tenant_id: tenantId, ...extra });
      return { id: s._id, token: tokenFor(s._id), doc: s };
    };
    const t = { key, tenantId, email };
    t.admin = await mk("Admin", { admin: true });
    t.viewOnly = await mk("Viewer", { permissions: { Goals: { "View(Global)": true } } });
    t.noAccess = await mk("Nobody", { permissions: {} });
    t.pick = [(await mk("PickA")).doc, (await mk("PickB")).doc, (await mk("PickC")).doc];
    t.contractTypes = await ContractType.create([{ name: `${key} AMC`, tenant_id: tenantId }, { name: `${key} Service`, tenant_id: tenantId }]);
    t.goals = await Goal.create(GOAL_TYPES.slice(0, 5).map((type, i) => ({
      subject: `${key} Goal ${i + 1}`, staff_member: t.pick[i % 3]._id, achievement: String(1000 * (i + 1)),
      start_date: new Date("2026-11-01"), end_date: new Date("2026-12-31"), goal_type: type, tenant_id: tenantId,
    })));
    T[key] = t;
  }
  return { T, Goal, Staff };
}

module.exports = { boot, bootTenants, seedAllTenants, stop, validBody, GOAL_TYPES, FIELD_CASES, TENANTS, tokenFor };
