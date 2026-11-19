// Customers full test pass (test-prompts/05-customers.md) — shared fixtures.
// Used by the jest suites in src/__tests__/customers/customers.fullpass.*.test.js and by
// the browser stack startCustomersFullpassStack.js (backend 127.0.0.1:5204).
//
// SAFETY
//  - connectMemoryDb() starts mongodb-memory-server and refuses anything that is not 127.0.0.1.
//    The real .env / MONGO_URI is never read (MONGO_URI is overwritten before any app module loads).
//  - blockOutbound() makes every non-local HTTP(S)/fetch call fail and records it.
//  - stubEmail() replaces EmailService.sendMail so no mail can leave the machine.
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const http = require("http");
const https = require("https");

const PASSWORD = "Test@1234";
const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW_GLOBAL = { "View(Global)": true };
const VIEW_OWN = { "View (Own)": true };
const OWN_EDITOR = { "View (Own)": true, Create: true, Edit: true, Delete: true };

const outboundAttempts = [];
const sentMails = [];

async function connectMemoryDb(jwtSecret = "crm-customers-fullpass-secret") {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = jwtSecret;
  delete process.env.JOB_SECRET;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  return { mongod, uri };
}

const isLocal = (host) => !host || /^(127\.0\.0\.1|localhost|::1|\[::1\])(:\d+)?$/i.test(String(host));

function blockOutbound() {
  if (global.__customersOutboundBlocked) return;
  global.__customersOutboundBlocked = true;
  const wrap = (mod) => {
    const orig = mod.request;
    mod.request = function (...args) {
      const a = args[0];
      let host = "";
      if (typeof a === "string") { try { host = new URL(a).host; } catch { host = ""; } }
      else if (a instanceof URL) host = a.host;
      else if (a && typeof a === "object") host = a.hostname || a.host || "";
      if (!isLocal(host)) {
        outboundAttempts.push(host);
        throw new Error(`[customers test] outbound request to ${host} blocked`);
      }
      return orig.apply(this, args);
    };
    mod.get = function (...args) { const r = mod.request(...args); r.end(); return r; };
  };
  wrap(http);
  wrap(https);
  if (typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url || String(input);
      let host = "";
      try { host = new URL(url).host; } catch { host = ""; }
      if (!isLocal(host)) {
        outboundAttempts.push(host);
        throw new Error(`[customers test] outbound fetch to ${host} blocked`);
      }
      return origFetch(input, init);
    };
  }
}

function stubEmail() {
  const EmailService = require("../services/EmailService");
  EmailService.sendMail = async (opts) => { sentMails.push(opts); return { messageId: "stubbed" }; };
  if (EmailService.sendEmail) EmailService.sendEmail = async (opts) => { sentMails.push(opts); return { messageId: "stubbed" }; };
  return EmailService;
}

const sign = (id, role = "staff") => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET);

// One company: admin, full, viewGlobal, viewOwn, ownEditor, noAccess (+ any extra perms).
async function seedTenant(key, { adminEmail, planId } = {}) {
  const Staff = require("../models/Staff");
  const db = mongoose.connection.db;
  const tenantId = new mongoose.Types.ObjectId();
  await db.collection("tenants").insertOne({
    _id: tenantId, company_name: `${key} Co`, status: "active", ...(planId ? { plan_id: planId } : {}),
    createdAt: new Date(), updatedAt: new Date(),
  });
  const users = {};
  const mk = async (kind, admin, permissions, email) => {
    const s = await Staff.create({
      firstname: kind.charAt(0).toUpperCase() + kind.slice(1), lastname: key,
      email: email || `${kind}.${key.toLowerCase()}@cust-test.local`, password: PASSWORD,
      active: true, admin, tenant_id: tenantId, permissions: permissions || {},
    });
    users[kind] = { id: s._id, email: s.email, token: sign(s._id), name: `${s.firstname} ${s.lastname}` };
  };
  await mk("admin", true, {}, adminEmail);
  await mk("full", false, { Customers: FULL, Leads: FULL, Invoices: FULL });
  await mk("viewGlobal", false, { Customers: VIEW_GLOBAL });
  await mk("viewOwn", false, { Customers: VIEW_OWN });
  await mk("ownEditor", false, { Customers: OWN_EDITOR });
  await mk("noAccess", false, {});
  return { key, tenantId, users };
}

// Full world used by both jest and the browser stack.
async function seedCustomersWorld({ extraCustomers = 30 } = {}) {
  const Client = require("../models/Client");
  const Contact = require("../models/Contact");
  const ClientGroup = require("../models/ClientGroup");
  const Currency = require("../models/Currency");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  const Invoice = require("../models/Invoice");
  const Payment = require("../models/Payment");
  const Reminder = require("../models/Reminder");
  const VaultEntry = require("../models/VaultEntry");
  const Subscription = require("../models/Subscription");
  const Note = require("../models/Note");
  const Lead = require("../models/Lead");
  const db = mongoose.connection.db;

  // A plan with every module switched off (Customers is core -> must still work).
  const planId = new mongoose.Types.ObjectId();
  const off = Object.fromEntries(["leads", "finance", "estimates", "proposals", "projects", "tasks", "support", "contracts", "expenses", "subscriptions", "sales", "customers"].map((k) => [k, false]));
  await db.collection("saasplans").insertOne({ _id: planId, name: "All Off", module_access: off, createdAt: new Date() });

  const A = await seedTenant("Alpha");
  const B = await seedTenant("Beta");
  const R = await seedTenant("Rudraverse", { adminEmail: "info@trinetratechnoworld.com" });
  const P = await seedTenant("PlanOff", { planId });

  const world = { A, B, R, P, planId };
  for (const T of [A, B, R, P]) {
    const t = T.tenantId;
    T.branches = await HRMSBranch.create([
      { name: `Ahmedabad Branch ${T.key}`, city: "Ahmedabad", tenant_id: t },
      { name: `Surat Branch ${T.key}`, city: "Surat", tenant_id: t },
    ]);
    T.groups = await ClientGroup.create([
      { name: "VIP", tenant_id: t },
      { name: "Wholesale", tenant_id: t },
    ]);
    await Currency.create([
      { name: "INR", symbol: "₹", isdefault: true, tenant_id: t },
      { name: "USD", symbol: "$", isdefault: false, tenant_id: t },
    ]);
    const u = T.users;
    T.c = {};
    T.c.acme = await Client.create({
      company: `Acme Corporation ${T.key}`, customer_reference: `ACME-${T.key}`, contact_person: "John Doe",
      phonenumber: "9876543210", email: `john@acme-${T.key.toLowerCase()}.com`, pan_number: "ABCDE1234F", gst_number: "24ABCDE1234F1Z5",
      currency: "INR", address: "1 CG Road", city: "Ahmedabad", state: "Gujarat", zip: "380001", country: "India",
      branch: T.branches[0]._id, groups: [T.groups[0]._id], active: true, tenant_id: t, created_by: u.admin.id,
    });
    T.c.own = await Client.create({ company: `Own Customer ${T.key}`, sales_person: u.viewOwn.id, active: true, tenant_id: t, created_by: u.admin.id, email: `own@${T.key.toLowerCase()}.com`, phonenumber: "9123456780" });
    T.c.ownEd = await Client.create({ company: `OwnEditor Customer ${T.key}`, admins: [{ staff: u.ownEditor.id }], active: true, tenant_id: t, created_by: u.admin.id });
    T.c.other = await Client.create({ company: `Other Customer ${T.key}`, active: true, tenant_id: t, created_by: u.admin.id, branch: T.branches[1]._id, groups: [T.groups[1]._id], pan_number: "PQRSX6789K" });
    T.c.inactive = await Client.create({ company: `Inactive Customer ${T.key}`, active: false, tenant_id: t, created_by: u.admin.id });
    T.c.blocked = await Client.create({ company: `Blocked Customer ${T.key}`, active: true, tenant_id: t, created_by: u.admin.id });
    T.c.stmt = await Client.create({ company: `Statement Customer ${T.key}`, active: true, tenant_id: t, created_by: u.admin.id, email: `stmt@${T.key.toLowerCase()}.com` });

    await Invoice.create({ client: T.c.blocked._id, number: `INV-BLK-${T.key}`, subtotal: 1000, total: 1000, status: "unpaid", tenant_id: t, date: new Date() });

    T.contacts = await Contact.create([
      { userid: T.c.acme._id, firstname: "John", lastname: "Doe", email: `john@acme-${T.key.toLowerCase()}.com`, phonenumber: "9876543210", is_primary: true, active: true, password: "PortalPass1", last_login: new Date() },
      { userid: T.c.acme._id, firstname: "Sarah", lastname: "Connor", email: `sarah@acme-${T.key.toLowerCase()}.com`, phonenumber: "9876543211", is_primary: false, active: true },
      { userid: T.c.other._id, firstname: "Olga", lastname: "Other", email: `olga@other-${T.key.toLowerCase()}.com`, is_primary: true, active: false },
      { userid: T.c.own._id, firstname: "Owen", lastname: "Own", email: `owen@own-${T.key.toLowerCase()}.com`, is_primary: true, active: true },
    ]);

    // Subscriptions: one for Acme, one for Other (Acme's tab must not show Other's).
    await Subscription.create([
      { name: `Acme Sub ${T.key}`, client: T.c.acme._id, amount: 500, tenant_id: t, currency: "INR" },
      { name: `Other Sub ${T.key}`, client: T.c.other._id, amount: 900, tenant_id: t, currency: "INR" },
    ]).catch((e) => console.log("[seed] subscription skipped:", e.message));

    // Vault: admins-only and self-only entries (visibility must be enforced).
    T.vault = await VaultEntry.create([
      { client: T.c.acme._id, server: "db.acme.local", username: "root", password: "AdminsOnlySecret", visibility: "admins", created_by: u.admin.id, tenant_id: t },
      { client: T.c.acme._id, server: "ftp.acme.local", username: "ftp", password: "OnlyMeSecret", visibility: "self", created_by: u.admin.id, tenant_id: t },
    ]);

    // Lead + lead reminder (customer reminder delete must not delete it).
    T.lead = await Lead.create({ name: `Lead Person ${T.key}`, company: `Acme Corporation ${T.key}`, email: `lead@${T.key.toLowerCase()}.com`, tenant_id: t });
    T.leadReminder = await Reminder.create({ description: "Lead follow-up", date: new Date(Date.now() + 864e5), staff: u.admin.id, rel_id: T.lead._id, rel_type: "lead", creator: u.admin.id, tenant_id: t });
    T.custReminder = await Reminder.create({ description: "Customer follow-up", date: new Date(Date.now() + 864e5), staff: u.admin.id, rel_id: T.c.acme._id, rel_type: "customer", creator: u.admin.id, tenant_id: t });
    T.note = await Note.create({ rel_id: T.c.acme._id, rel_type: "customer", description: `Secret note ${T.key}`, addedfrom: u.admin.id, tenant_id: t, dateadded: new Date() }).catch(() => null);
  }

  // Statement fixture (Alpha): hand-calculable numbers.
  //  - INV-S1  10 000  dated 2026-09-15 (before the period) ; payment 4 000 on 2026-09-20 (before period)
  //  - INV-S2   5 000  dated 2026-10-10 (in period)          ; payment 2 000 on 2026-10-31 (LAST DAY of period, 12:00 UTC)
  //  - INV-S3   3 000  dated 2026-10-31T15:00Z (last day, in period)
  //  - INV-SD   7 777  draft, INV-SC 8 888 cancelled (both excluded)
  // Period 2026-10-01..2026-10-31: beginning 6 000, invoiced 8 000, paid 2 000, balance due 12 000.
  const s = A.c.stmt._id;
  const inv = await Invoice.create([
    { client: s, number: "INV-S1", subtotal: 10000, total: 10000, status: "partially_paid", date: new Date("2026-09-15T10:00:00Z"), duedate: new Date("2026-09-30"), tenant_id: A.tenantId },
    { client: s, number: "INV-S2", subtotal: 5000, total: 5000, status: "partially_paid", date: new Date("2026-10-10T10:00:00Z"), duedate: new Date("2026-10-20"), tenant_id: A.tenantId },
    { client: s, number: "INV-S3", subtotal: 3000, total: 3000, status: "unpaid", date: new Date("2026-10-31T15:00:00Z"), duedate: new Date("2026-11-30"), tenant_id: A.tenantId },
    { client: s, number: "INV-SD", subtotal: 7777, total: 7777, status: "draft", date: new Date("2026-10-12T10:00:00Z"), duedate: new Date("2026-10-01"), tenant_id: A.tenantId },
    { client: s, number: "INV-SC", subtotal: 8888, total: 8888, status: "cancelled", date: new Date("2026-10-13T10:00:00Z"), duedate: new Date("2026-10-01"), tenant_id: A.tenantId },
  ]);
  await Payment.create([
    { invoice: inv[0]._id, client: s, amount: 4000, date: new Date("2026-09-20T10:00:00Z"), tenant_id: A.tenantId },
    { invoice: inv[1]._id, client: s, amount: 2000, date: new Date("2026-10-31T12:00:00Z"), tenant_id: A.tenantId },
  ]);
  A.statementInvoices = inv;

  // Legacy customer without tenant_id (suspected bug #2).
  const legacyId = new mongoose.Types.ObjectId();
  await db.collection("clients").insertOne({ _id: legacyId, company: "Legacy NoTenant Customer", active: true, groups: [], admins: [], createdAt: new Date(), updatedAt: new Date() });
  world.legacyId = legacyId;

  // XSS / long-text customer rows inserted raw (stand in for old data or a bypass).
  await db.collection("clients").insertMany([
    { company: "XSS <img src=x onerror=\"window.__xss=1\"> Co", contact_person: "<script>window.__xss=2</script>", tenant_id: A.tenantId, active: true, groups: [], admins: [], createdAt: new Date(Date.now() - 1000), updatedAt: new Date() },
    { company: `Long ${"VeryLongCompanyName ".repeat(9)}`.slice(0, 200), tenant_id: A.tenantId, active: true, groups: [], admins: [], createdAt: new Date(Date.now() - 2000), updatedAt: new Date() },
  ]);

  // Extra rows for pagination (Alpha).
  if (extraCustomers > 0) {
    const docs = [];
    for (let i = 0; i < extraCustomers; i++) {
      docs.push({ company: `Pager Customer ${String(i + 1).padStart(3, "0")}`, email: `pager${i}@alpha.com`, phonenumber: `98${String(10000000 + i)}`, tenant_id: A.tenantId, active: i % 5 !== 0, groups: [], admins: [], branch: A.branches[i % 2]._id, createdAt: new Date(Date.now() - (10000 + i * 1000)), updatedAt: new Date() });
    }
    await db.collection("clients").insertMany(docs);
  }
  return world;
}

module.exports = {
  PASSWORD, FULL, VIEW_GLOBAL, VIEW_OWN, OWN_EDITOR,
  connectMemoryDb, blockOutbound, stubEmail, seedTenant, seedCustomersWorld, sign,
  outboundAttempts, sentMails,
};
