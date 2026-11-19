// Seed data for the DASHBOARD module tests (jest + the :5201 browser stack).
// Only ever called after mongoose is connected to an in-memory 127.0.0.1 server
// (startDashboardTestStack.boot / dashboardTestApp enforce that before requiring this file).
//
// Companies:
//   A        "Alpha Dash Co"   full plan, the KNOWN numbers below (every widget checked by hand)
//   B        "Beta Dash Co"    full plan, different numbers (company separation)
//   R        "Rudraverse"      owner info@trinetratechnoworld.com, same shape as B
//   OFF      "OffPlan Dash Co" plan with every dashboard module switched off
//   GRACE    "Grace Dash Co"   plan ended 3 days ago (inside the 7-day grace -> no lock)
//   EXPIRED  "Expired Dash Co" plan ended 10 days ago (past grace -> dashboard lock)
// Users in A: admin, full (all caps), vglobal (View(Global) everywhere), vown (View (Own)
// everywhere), none (role with no permissions). B: admin + vglobal. Others: admin.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const DAY = 864e5;
const oid = () => new mongoose.Types.ObjectId();
const sign = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET, { expiresIn: "10h" });

const MODULES = ["Invoices", "Estimates", "Proposals", "Quotations", "Tasks", "Projects", "Support", "Leads", "Expenses", "Activity Log", "Announcements", "Customers", "Payments", "Reminders"];
const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW_GLOBAL = { "View(Global)": true };
const VIEW_OWN = { "View (Own)": true };
const permsFor = (caps) => Object.fromEntries(MODULES.map((m) => [m, caps]));

const ALL_ON = {
  finance: true, leads: true, support: true, contracts: true, projects: true, tasks: true, chat: true, meetings: true,
  subscriptions: true, expenses: true, estimates: true, proposals: true, estimate_request: true, knowledge_base: true,
  reports: true, time_tracking: true, goals: true, announcements: true, calendar: true, bookmarks: true, hrms: true,
  sales: true, utility: true, website_forms: true, whatsapp: true,
};
const DASH_MODULES = ["finance", "estimates", "proposals", "sales", "tasks", "projects", "support", "announcements", "leads", "expenses", "utility"];
const OFF = { ...ALL_ON, ...Object.fromEntries(DASH_MODULES.map((k) => [k, false])) };

const YEAR = new Date().getFullYear();
const at = (y, m, d = 10) => new Date(Date.UTC(y, m, d, 6, 0, 0));
const future = () => new Date(Date.now() + 30 * DAY);

async function makePlan(db, name, module_access) {
  const _id = oid();
  await db.collection("saasplans").insertOne({ _id, name, price: 999, billing_cycle: "monthly", module_access, trial_days: 14, banner_warning_days: 30, status: "active", createdAt: new Date(), updatedAt: new Date() });
  return _id;
}

async function makeTenant(db, { key, name, planId, adminEmail, cycleEnd = future(), status = "active" }) {
  const tenantId = oid();
  const adminId = oid();
  await db.collection("tenants").insertOne({
    _id: tenantId, company_name: name, status, plan_id: planId, owner_id: adminId,
    billing_cycle_start: new Date(cycleEnd.getTime() - 30 * DAY), billing_cycle_end: cycleEnd,
    createdAt: new Date(Date.now() - 60 * DAY), updatedAt: new Date(),
  });
  await db.collection("staffs").insertOne({
    _id: adminId, firstname: `Admin${key}`, lastname: "Owner", email: adminEmail, password: "x",
    active: true, admin: true, tenant_id: tenantId, createdAt: new Date(), updatedAt: new Date(),
  });
  return { key, name, tenantId, admin: { id: adminId, email: adminEmail, token: sign(adminId) }, users: { admin: { id: adminId, email: adminEmail, token: sign(adminId) } } };
}

async function addStaff(db, t, kind, perms) {
  const roleId = oid();
  // Role names must not contain "admin"/"owner"/"super" (the frontend would treat them as admins).
  await db.collection("roles").insertOne({ _id: roleId, name: `Dash ${kind} ${t.key}`, permissions: perms, default_modules: [{ module: "dashboard", permission: "" }], tenant_id: t.tenantId, createdAt: new Date(), updatedAt: new Date() });
  const id = oid();
  const email = `${kind}.${t.key.toLowerCase()}@dash-test.local`;
  await db.collection("staffs").insertOne({
    _id: id, firstname: `${kind[0].toUpperCase()}${kind.slice(1)}${t.key}`, lastname: "Staff", email, password: "x",
    active: true, admin: false, role: roleId, tenant_id: t.tenantId, createdAt: new Date(), updatedAt: new Date(),
  });
  t.users[kind] = { id, email, token: sign(id), roleId };
  return t.users[kind];
}

// ---------------------------------------------------------------------------------
// Company A: the known data set. EXPECTED holds the business-rule answers.
// ---------------------------------------------------------------------------------
async function seedCompanyA(db, t) {
  const T = t.tenantId;
  const admin = t.users.admin.id;
  const vown = t.users.vown.id;
  const vglobal = t.users.vglobal.id;
  const client = oid();
  await db.collection("clients").insertOne({ _id: client, company: "Alpha Customer Pvt Ltd", tenant_id: T, active: true, createdAt: new Date(), updatedAt: new Date() });

  const inv = (number, status, total, extra = {}) => ({
    _id: oid(), number, status, total, subtotal: total, currency: "INR", client, tenant_id: T,
    date: at(YEAR, 6), duedate: future(), created_by: admin, items: [], createdAt: new Date(Date.now() - DAY), updatedAt: new Date(), ...extra,
  });
  const partial = inv("A-PART", "partially_paid", 4000);
  const invoices = [
    inv("A-DRAFT", "draft", 100),
    inv("A-UNPAID1", "unpaid", 1000),
    inv("A-UNPAID2", "unpaid", 2000, { created_by: vown }),
    inv("A-SENT", "sent", 500),
    inv("A-SENTLATER", "sent_later", 300),
    partial,
    inv("A-OVERDUE", "overdue", 700, { duedate: new Date(Date.now() - 20 * DAY) }),
    inv("A-PAID-THIS", "paid", 1200, { date: at(YEAR, 2) }),
    inv("A-PAID-LAST", "paid", 800, { date: at(YEAR - 1, 2) }),
    inv("A-RECORDED", "recorded", 600, { date: at(YEAR, 5) }),
    inv("A-CANCELLED", "cancelled", 900),
    inv("A-USD", "unpaid", 50, { currency: "USD" }),
    // Unpaid with a due date in the past: GET /api/invoices rewrites it to "overdue".
    inv("A-PASTDUE", "unpaid", 250, { duedate: new Date(Date.now() - 5 * DAY) }),
  ];
  await db.collection("invoices").insertMany(invoices);
  await db.collection("payments").insertOne({ _id: oid(), invoice: partial._id, amount: 1500, tenant_id: T, date: new Date(), createdAt: new Date(), updatedAt: new Date() });

  await db.collection("expenses").insertMany([
    { _id: oid(), category: "Travel", amount: 300, date: at(YEAR, 2), tenant_id: T, addedfrom: admin, createdAt: new Date(), updatedAt: new Date() },
    { _id: oid(), category: "Travel", amount: 700, date: at(YEAR - 1, 2), tenant_id: T, addedfrom: admin, createdAt: new Date(), updatedAt: new Date() },
  ]);

  // Lead statuses (incl. a custom name) and leads.
  const st = {};
  for (const [i, name] of ["Pending", "Followup", "Hot Lead", "Customer", "VIP Prospect"].entries()) {
    st[name] = oid();
    await db.collection("leadstatuses").insertOne({ _id: st[name], name, statusorder: i, tenant_id: T, createdAt: new Date(), updatedAt: new Date() });
  }
  const lead = (name, status, extra = {}) => ({ _id: oid(), name, status: st[status], tenant_id: T, addedfrom: admin, created_by: admin, converted: false, dateadded: new Date(), createdAt: new Date(), updatedAt: new Date(), ...extra });
  await db.collection("leads").insertMany([
    lead("Lead conv 1", "Hot Lead", { converted: true }),
    lead("Lead conv 2", "Hot Lead", { converted: true }),
    lead("Lead conv 3", "Followup", { converted: true }),
    lead("Lead customer status", "Customer"),
    lead("Lead VIP 1", "VIP Prospect"),
    lead("Lead VIP 2", "VIP Prospect"),
    lead("Lead pending 1", "Pending"),
    lead("Lead pending 2", "Pending", { assigned: vown, addedfrom: vown, created_by: vown }),
    lead("Lead followup", "Followup"),
    lead("Lead hot", "Hot Lead"),
  ]);

  // Projects: status 1 Not Started, 2 In Progress, 3 On Hold, 4 Finished, 5 Cancelled
  const proj = (name, status, team = [], extra = {}) => ({ _id: oid(), name, status, clientid: client, team, tenant_id: T, start_date: new Date(), created_by: admin, addedfrom: admin, progress: 10, createdAt: new Date(), updatedAt: new Date(), ...extra });
  await db.collection("projects").insertMany([
    proj("Proj NotStarted", 1),
    proj("Proj Active 1", 2, [vown]),
    proj("Proj Active 2", 2),
    proj("Proj OnHold", 3),
    proj("Proj Finished", 4),
    proj("Proj Cancelled", 5),
  ]);

  // Tasks: status 1 Not Started, 2 In Progress, 3 Testing, 4 Awaiting Feedback, 5 Complete (Tasks page)
  const task = (name, status, minsAgo, extra = {}) => ({ _id: oid(), name, status, priority: 2, tenant_id: T, created_by: admin, addedfrom: admin, assignees: [admin], followers: [], startdate: new Date(Date.now() - minsAgo * 60000), dateadded: new Date(Date.now() - minsAgo * 60000), createdAt: new Date(Date.now() - minsAgo * 60000), updatedAt: new Date(), category: "To-Do", ...extra });
  await db.collection("tasks").insertMany([
    task("Task OLDEST NotStarted", 1, 900),
    task("Task old InProgress", 2, 800),
    task("Task Testing", 3, 700),
    task("Task Awaiting", 4, 600),
    task("Task Complete 1", 5, 500),
    task("Task Complete 2", 5, 400),
    task("Task NotStarted mid", 1, 300),
    task("Task InProgress new", 2, 200, { assignees: [vown] }),
    task("Task NEWEST NotStarted", 1, 10),
  ]);

  // Tickets: 7, created at different times, one with no customer.
  const tk = (subject, status, minsAgo, extra = {}) => ({ _id: oid(), subject, status, department: oid(), tenant_id: T, client, message: "m", createdAt: new Date(Date.now() - minsAgo * 60000), updatedAt: new Date(), date: new Date(Date.now() - minsAgo * 60000), ...extra });
  await db.collection("tickets").insertMany([
    tk("Ticket OLDEST", "open", 700),
    tk("Ticket 2", "open", 600),
    tk("Ticket 3", "answered", 500),
    tk("Ticket 4", "closed", 400),
    tk("Ticket 5", "open", 300),
    tk("Ticket 6", "in progress", 200),
    tk("Ticket NEWEST no customer", "open", 10, { client: null }),
  ]);

  const est = (number, status) => ({ _id: oid(), number, status, clientid: client, client, tenant_id: T, date: new Date(), expirydate: future(), subtotal: 100, total: 100, currency: "INR", created_by: admin, addedfrom: admin, createdAt: new Date(), updatedAt: new Date() });
  await db.collection("estimates").insertMany([est("E1", "draft"), est("E2", "sent"), est("E3", "sent"), est("E4", "declined"), est("E5", "accepted"), est("E6", "expired")]);

  const prop = (subject, status) => ({ _id: oid(), subject, status, rel_type: "customer", rel_id: client, proposal_to: "Alpha", tenant_id: T, date: new Date(), total: 100, subtotal: 100, created_by: admin, addedfrom: admin, createdAt: new Date(), updatedAt: new Date() });
  await db.collection("proposals").insertMany([prop("P1", 1), prop("P2", 2), prop("P3", 3), prop("P4", 6)]);

  const q = (number, status, minsAgo) => ({ _id: oid(), number, status, client, tenant_id: T, date: new Date(Date.now() - minsAgo * 60000), subtotal: 100, total: 100, created_by: admin, items: [], createdAt: new Date(Date.now() - minsAgo * 60000), updatedAt: new Date() });
  await db.collection("quotations").insertMany([q("Q-OLDEST", "draft", 700), q("Q-2", "sent", 600), q("Q-3", "pending", 500), q("Q-4", "accepted", 400), q("Q-5", "rejected", 300), q("Q-6", "expired", 200), q("Q-NEWEST", "sent", 10)]);

  // Reminders: two for admin, two for vglobal, one completed (must not show).
  const rem = (description, staff, status = "pending") => ({ _id: oid(), description, date: future(), staff, creator: staff, rel_id: client, rel_type: "customer", status, tenant_id: T, isnotified: false, createdAt: new Date(), updatedAt: new Date() });
  await db.collection("reminders").insertMany([
    rem("Admin reminder 1", admin), rem("Admin reminder 2", admin),
    rem("VGlobal private reminder", vglobal), rem("VOwn private reminder", vown),
    rem("Admin completed reminder", admin, "completed"),
  ]);

  // Announcements (raw insert, with created_by set for the author check).
  const ann = (name, extra = {}) => ({ _id: oid(), name, message: `<p>${name} body</p>`, showtostaff: true, showtousers: true, showname: true, tenant_id: T, created_by: admin, dateadded: new Date(), createdAt: new Date(), updatedAt: new Date(), ...extra });
  await db.collection("announcements").insertMany([
    ann("Ann staff visible", { dateadded: new Date(Date.now() - 3 * DAY) }),
    ann("Ann hidden name", { showname: false, dateadded: new Date(Date.now() - 2 * DAY) }),
    ann("Ann clients only", { showtostaff: false, dateadded: new Date(Date.now() - DAY) }),
  ]);

  // Activity logs (staffid = the real field).
  await db.collection("activitylogs").insertMany([
    { _id: oid(), description: "Created invoice A-UNPAID1", staffid: admin, rel_type: "invoice", tenant_id: T, date: new Date(Date.now() - 5 * 60000), createdAt: new Date(), updatedAt: new Date() },
    { _id: oid(), description: "Updated lead Lead hot", staffid: vglobal, rel_type: "lead", tenant_id: T, date: new Date(Date.now() - 2 * 60000), createdAt: new Date(), updatedAt: new Date() },
  ]);

  return {
    clientId: client,
    invoiceIds: Object.fromEntries(invoices.map((i) => [i.number, i._id])),
    EXPECTED: {
      invoicesTotal: 13,
      // unpaid(A-UNPAID1, A-UNPAID2, A-USD, A-PASTDUE) + sent + sent_later + partially_paid + overdue
      awaiting: 9,
      // Statuses on the overview after load (A-PASTDUE becomes overdue): what each bucket should hold.
      byStatus: { draft: 1, unpaid: 3, sent: 1, sent_later: 1, partially_paid: 1, overdue: 2, paid: 2, recorded: 1, cancelled: 1 },
      // INR only, remaining balance: 1000 + 2000 + 500 + 300 + (4000 - 1500)
      outstandingINR: 6300,
      pastDueINR: 950, // 700 + 250
      paidINR: 2600, // 1200 + 800 + 600 (paid + recorded)
      revenueThisYear: { Mar: 1200, Jun: 600 },
      expensesThisYear: { Mar: 300 },
      leadsTotal: 10,
      convertedLeads: 4, // 3 converted=true + 1 status "Customer"
      projectsTotal: 6,
      projectsInProgress: 2,
      tasksTotal: 9,
      tasksNotFinished: 7,
      taskByLabel: { "Not Started": 3, "In Progress": 2, Testing: 1, "Awaiting Feedback": 1, Complete: 2 },
      newestTickets: ["Ticket NEWEST no customer", "Ticket 6", "Ticket 5", "Ticket 4", "Ticket 3"],
      newestOpenTasks: ["Task NEWEST NotStarted", "Task InProgress new", "Task NotStarted mid", "Task Awaiting", "Task Testing"],
      newestQuotations: ["Q-NEWEST", "Q-6", "Q-5", "Q-4", "Q-3"],
      adminReminders: ["Admin reminder 1", "Admin reminder 2"],
      vownOwn: { invoices: 1, leads: 1, tasks: 1, projects: 1 },
    },
  };
}

// Company B / Rudraverse: a different, smaller data set.
async function seedSmallCompany(db, t, prefix) {
  const T = t.tenantId;
  const admin = t.users.admin.id;
  const client = oid();
  await db.collection("clients").insertOne({ _id: client, company: `${prefix} Customer`, tenant_id: T, createdAt: new Date(), updatedAt: new Date() });
  await db.collection("invoices").insertMany([1, 2, 3].map((n) => ({ _id: oid(), number: `${prefix}-INV-${n}`, status: "paid", total: 100000, subtotal: 100000, currency: "INR", client, tenant_id: T, date: at(YEAR, 2), duedate: future(), created_by: admin, items: [], createdAt: new Date(), updatedAt: new Date() })));
  await db.collection("leads").insertMany([1, 2].map((n) => ({ _id: oid(), name: `${prefix} lead ${n}`, tenant_id: T, converted: true, addedfrom: admin, createdAt: new Date(), updatedAt: new Date() })));
  await db.collection("tasks").insertOne({ _id: oid(), name: `${prefix} task SECRET`, status: 1, priority: 2, tenant_id: T, created_by: admin, assignees: [admin], createdAt: new Date(), updatedAt: new Date() });
  await db.collection("reminders").insertOne({ _id: oid(), description: `${prefix} reminder SECRET`, date: future(), staff: admin, creator: admin, rel_id: client, rel_type: "customer", status: "pending", tenant_id: T, createdAt: new Date(), updatedAt: new Date() });
  await db.collection("todos").insertOne({ _id: oid(), description: `${prefix} todo SECRET`, staff: admin, tenant_id: T, finished: false, createdAt: new Date(), updatedAt: new Date() });
}

async function seedAll() {
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("dashboardSeed: refusing non-local DB");
  const db = mongoose.connection.db;
  const fullPlan = await makePlan(db, "Dash Full Plan", ALL_ON);
  const offPlan = await makePlan(db, "Dash Off Plan", OFF);

  const A = await makeTenant(db, { key: "A", name: "Alpha Dash Co", planId: fullPlan, adminEmail: "admin.a@dash-test.local" });
  await addStaff(db, A, "full", permsFor(FULL));
  await addStaff(db, A, "vglobal", permsFor(VIEW_GLOBAL));
  await addStaff(db, A, "vown", permsFor(VIEW_OWN));
  await addStaff(db, A, "none", {});
  const B = await makeTenant(db, { key: "B", name: "Beta Dash Co", planId: fullPlan, adminEmail: "admin.b@dash-test.local" });
  await addStaff(db, B, "vglobal", permsFor(VIEW_GLOBAL));
  const R = await makeTenant(db, { key: "R", name: "Rudraverse", planId: fullPlan, adminEmail: "info@trinetratechnoworld.com" });
  const OFFT = await makeTenant(db, { key: "OFF", name: "OffPlan Dash Co", planId: offPlan, adminEmail: "admin.off@dash-test.local" });
  const GRACE = await makeTenant(db, { key: "GRACE", name: "Grace Dash Co", planId: fullPlan, adminEmail: "admin.grace@dash-test.local", cycleEnd: new Date(Date.now() - 3 * DAY) });
  const EXPIRED = await makeTenant(db, { key: "EXPIRED", name: "Expired Dash Co", planId: fullPlan, adminEmail: "admin.expired@dash-test.local", cycleEnd: new Date(Date.now() - 10 * DAY) });

  const a = await seedCompanyA(db, A);
  await seedSmallCompany(db, B, "BETA");
  await seedSmallCompany(db, R, "RUDRA");
  await seedSmallCompany(db, OFFT, "OFF");
  await seedSmallCompany(db, EXPIRED, "EXP");

  return { A: { ...A, ...a }, B, R, OFF: OFFT, GRACE, EXPIRED, plans: { fullPlan, offPlan }, ALL_ON, OFF_ACCESS: OFF, DASH_MODULES };
}

// Bulk data for the performance phase: 5,000 invoices, 5,000 leads, 2,000 tasks in a tenant.
async function seedBulk(tenantId, adminId, { invoices = 5000, leads = 5000, tasks = 2000 } = {}) {
  const db = mongoose.connection.db;
  const client = oid();
  await db.collection("clients").insertOne({ _id: client, company: "Bulk Customer", tenant_id: tenantId, createdAt: new Date(), updatedAt: new Date() });
  const statuses = ["unpaid", "paid", "partially_paid", "draft", "sent"];
  const inv = Array.from({ length: invoices }, (_, i) => ({ _id: oid(), number: `BULK-${i}`, status: statuses[i % 5], total: 1000 + i, subtotal: 1000 + i, currency: "INR", client, tenant_id: tenantId, date: new Date(), duedate: future(), created_by: adminId, items: [{ description: "Bulk item", qty: 1, rate: 1000 + i, amount: 1000 + i }], notes: "x".repeat(200), createdAt: new Date(), updatedAt: new Date() }));
  for (let i = 0; i < inv.length; i += 1000) await db.collection("invoices").insertMany(inv.slice(i, i + 1000));
  const ld = Array.from({ length: leads }, (_, i) => ({ _id: oid(), name: `Bulk lead ${i}`, email: `bulk${i}@x.test`, phonenumber: "9876543210", tenant_id: tenantId, converted: i % 10 === 0, addedfrom: adminId, description: "y".repeat(200), createdAt: new Date(), updatedAt: new Date() }));
  for (let i = 0; i < ld.length; i += 1000) await db.collection("leads").insertMany(ld.slice(i, i + 1000));
  const tk = Array.from({ length: tasks }, (_, i) => ({ _id: oid(), name: `Bulk task ${i}`, status: (i % 5) + 1, priority: 2, tenant_id: tenantId, created_by: adminId, assignees: [adminId], description: "z".repeat(200), createdAt: new Date(), updatedAt: new Date() }));
  for (let i = 0; i < tk.length; i += 1000) await db.collection("tasks").insertMany(tk.slice(i, i + 1000));
}

module.exports = { seedAll, seedBulk, sign, MODULES, ALL_ON, OFF, DASH_MODULES };
