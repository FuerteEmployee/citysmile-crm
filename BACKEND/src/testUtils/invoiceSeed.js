// Seed data for the Invoices module tests (jest + the :5102 browser stack).
// Only ever called after MONGO_URI points at an in-memory 127.0.0.1 server
// (crmTestApp.start / startInvoicesTestStack.boot enforce that).
//
// Six companies (TENANTS below), each with admin / viewer / editor / own / nobody
// staff, 3 customers (GJ, MH, no GSTIN), taxes, currencies, payment modes, branches,
// bank details and one invoice "INV-SHARED-1" (same number in every company).
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW_ONLY = { "View(Global)": true };
// View (Own) + Create: can add invoices and see only the ones they are the sale agent of.
const OWN_ONLY = { "View (Own)": true, Create: true };

const sign = (id) => jwt.sign({ id: String(id), role: "staff" }, process.env.JWT_SECRET);

// The six companies the user runs this code for. Same code everywhere; only the
// login email switches on the Trinetra/Rudraverse and Ekagra special paths.
// (BeOnTime, CitySmile, Kiran and OffixNest are separate deployments in real
// life — here they are just fake tenants in one in-memory DB.)
const TENANTS = [
  { key: "beontime", label: "BeOnTime", email: "admin@beontime.inv-test.local" },
  { key: "citysmile", label: "CitySmile", email: "admin@citysmile.inv-test.local" },
  { key: "kiran", label: "Kiran", email: "admin@kiran.inv-test.local" },
  { key: "offixnest", label: "OffixNest", email: "admin@offixnest.inv-test.local" },
  { key: "rudraverse", label: "Rudraverse", email: "info@trinetratechnoworld.com", sidebar: true },
  { key: "ekagra", label: "Ekagra", email: "ekagraengineering@gmail.com", bihar: true },
];

// Rudraverse's flat custom sidebar (src/scripts/set_tenant_sidebar_trinetra.js),
// trimmed to the rows that matter here.
const RUDRAVERSE_SIDEBAR = [
  { title: "Dashboard", url: "/admin/dashboard", icon: "LayoutDashboard" },
  { title: "Customers", url: "/admin/customers", icon: "Users", permission: "Customers" },
  { title: "Sales", url: "/admin/invoices", icon: "FileText", permission: "Invoices" },
  { title: "Payment", url: "/admin/payments", icon: "Wallet", permission: "Payments" },
].map((item, i) => ({ ...item, group: "Main", order: i + 1 }));

async function seedCatalog(tenantId, label, extraCustomers = []) {
  const Client = require("../models/Client");
  const Project = require("../models/Project");
  const Item = require("../models/Item");
  const Tax = require("../models/Tax");
  const Currency = require("../models/Currency");
  const PaymentMode = require("../models/PaymentMode");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");

  const branches = await HRMSBranch.create([
    { name: `Ahmedabad Branch ${label}`, city: "Ahmedabad", tenant_id: tenantId },
    { name: `Surat Branch ${label}`, city: "Surat", tenant_id: tenantId },
  ]);
  const base = [
    { key: "guj", company: `Gujarat Traders ${label}`, gst_number: "24AAAAA1111A1Z5", state: "Gujarat", city: "Ahmedabad", address: "1 CG Road" },
    { key: "mah", company: `Mumbai Metals ${label}`, gst_number: "27BBBBB2222B1Z5", state: "Maharashtra", city: "Mumbai", address: "2 Marine Drive" },
    { key: "nogst", company: `No GST Co ${label}`, gst_number: "", state: "", city: "", address: "" },
    ...extraCustomers,
  ];
  const customers = {};
  for (const c of base) {
    const { key, ...rest } = c;
    customers[key] = await Client.create({ ...rest, currency: "INR", active: true, tenant_id: tenantId, branch: branches[0]._id });
  }
  const projects = {};
  for (const [k, c] of Object.entries(customers)) {
    projects[k] = await Project.create({ name: `Project ${k} ${label}`, clientid: c._id, tenant_id: tenantId });
  }
  const items = await Item.create([
    { name: "Widget", description: "Widget", rate: 500, tenant_id: tenantId },
    { name: "Gadget", description: "Gadget", rate: 99.99, tenant_id: tenantId },
    { name: "Service Hour", description: "Service Hour", rate: 33.33, tenant_id: tenantId },
  ]);
  const taxes = await Tax.create([
    { name: "Zero", taxrate: 0, tenant_id: tenantId },
    { name: "GST 5", taxrate: 5, tenant_id: tenantId },
    { name: "GST 18", taxrate: 18, tenant_id: tenantId },
    { name: "IGST 18 (dup)", taxrate: 18, tenant_id: tenantId },
  ]);
  const currencies = await Currency.create([
    { name: "INR", symbol: "₹", isdefault: true, tenant_id: tenantId },
    { name: "USD", symbol: "$", isdefault: false, tenant_id: tenantId },
  ]);
  const paymentModes = await PaymentMode.create([
    { name: "Bank", tenant_id: tenantId },
    { name: "Cash", tenant_id: tenantId },
  ]);
  return { branches, customers, projects, items, taxes, currencies, paymentModes };
}

async function mkStaff(tenantId, email, firstname, extra = {}) {
  const Staff = require("../models/Staff");
  const s = await Staff.create({
    firstname, lastname: "Test", email, password: "x", active: true, tenant_id: tenantId, admin: false, ...extra,
  });
  return { id: s._id, email, token: sign(s._id) };
}

async function seedTenant(t) {
  const Tenant = require("../models/Tenant");
  const Invoice = require("../models/Invoice");
  const BankDetail = require("../models/BankDetail");
  const tenantId = new mongoose.Types.ObjectId();
  await Tenant.create({ _id: tenantId, company_name: `${t.label} Test Co`, status: "active", ...(t.sidebar ? { sidebar_config: RUDRAVERSE_SIDEBAR } : {}) });
  const extra = t.bihar ? [{ key: "bihar", company: `Patna Power ${t.label}`, gst_number: "10CCCCC3333C1Z5", state: "Bihar", city: "Patna", address: "3 Boring Road" }] : [];
  const T = { key: t.key, label: t.label, tenantId, ...(await seedCatalog(tenantId, t.label, extra)) };
  const dom = `${t.key}.inv-test.local`;
  T.admin = await mkStaff(tenantId, t.email, `Admin${t.label}`, { admin: true });
  T.viewer = await mkStaff(tenantId, `viewer@${dom}`, `Viewer${t.label}`, { permissions: { Invoices: VIEW_ONLY } });
  T.editor = await mkStaff(tenantId, `editor@${dom}`, `Editor${t.label}`, { permissions: { Invoices: FULL, Payments: FULL } });
  T.own = await mkStaff(tenantId, `own@${dom}`, `Own${t.label}`, { permissions: { Invoices: OWN_ONLY } });
  T.nobody = await mkStaff(tenantId, `nobody@${dom}`, `Nobody${t.label}`, { permissions: {} });
  T.sales = await mkStaff(tenantId, `sales@${dom}`, `Sales${t.label}`, { permissions: { Invoices: VIEW_ONLY } });
  T.bank = await BankDetail.create([
    { bankName: `${t.label} Bank`, accountHolderName: t.label, accountNumber: "111", ifscCode: "BANK0001", branch: T.branches[0]._id, active: true, tenant_id: tenantId },
    { bankName: "Old Bank", accountHolderName: t.label, accountNumber: "999", ifscCode: "OLD0001", active: false, tenant_id: tenantId },
  ]);
  T.invoice = await Invoice.create({
    client: T.customers.guj._id, number: "INV-SHARED-1", tenant_id: tenantId, subtotal: 1000, total: 1180, total_tax: 180,
    items: [{ description: `Secret ${t.label} item`, qty: 1, rate: 1000, tax: 18 }], status: "unpaid",
  });
  T.flags = { pilot: t.email === "info@trinetratechnoworld.com", ekagra: t.email === "ekagraengineering@gmail.com" };
  T.flags.bank = T.flags.pilot || T.flags.ekagra;
  return T;
}

async function seedAll() {
  const out = { list: [] };
  for (const t of TENANTS) {
    const T = await seedTenant(t);
    out[t.key] = T;
    out.list.push(T);
  }
  // Short aliases for the single-tenant suites: A = a normal company, B = another company.
  out.A = out.beontime;
  out.B = out.citysmile;
  out.R = out.rudraverse;
  out.E = out.ekagra;
  return out;
}

module.exports = { TENANTS, seedAll, sign, FULL, VIEW_ONLY, OWN_ONLY };
