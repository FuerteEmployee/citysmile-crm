// Customers Module Test Stack
// In-memory MongoDB -> Backend on :5101
// NEVER touches live database, NEVER touches :5001 or :5183.

const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const path = require("path");

let mongod;
let server;

async function boot() {
  console.log("==================================================================");
  console.log("STARTING CUSTOMERS TEST STACK (In-memory DB + Backend :5101)");
  console.log("==================================================================");

  // 1. In-memory Mongo
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-customers-test-secret";
  process.env.PORT = "5101";
  delete process.env.JOB_SECRET;

  console.log(`[GUARD CHECK 1] In-memory Mongo URI: ${uri}`);
  if (!uri.startsWith("mongodb://127.0.0.1")) {
    throw new Error(`CRITICAL GUARD FAILURE: Expected in-memory URI on 127.0.0.1, got: ${uri}`);
  }

  await mongoose.connect(uri);
  const { host } = mongoose.connection;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error(`CRITICAL GUARD FAILURE: Refusing non-local DB host: ${host}`);
  }
  console.log(`[GUARD CHECK 1 PASSED] Connected to in-memory DB at ${host}`);

  // 2. Load models
  const Client = require("../models/Client");
  const Contact = require("../models/Contact");
  const ClientGroup = require("../models/ClientGroup");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  const Staff = require("../models/Staff");
  const Currency = require("../models/Currency");
  const Invoice = require("../models/Invoice");
  const Payment = require("../models/Payment");
  const Note = require("../models/Note");
  const VaultEntry = require("../models/VaultEntry");
  const Reminder = require("../models/Reminder");
  const Tenant = require("../models/Tenant");

  // 3. Seed data
  const tenantAId = new mongoose.Types.ObjectId();
  const tenantBId = new mongoose.Types.ObjectId();

  await Tenant.create([
    { _id: tenantAId, company_name: "Tenant A Corp", status: "active" },
    { _id: tenantBId, company_name: "Tenant B Corp", status: "active" },
  ]);

  const adminAId = new mongoose.Types.ObjectId();
  const viewerAId = new mongoose.Types.ObjectId();
  const editorAId = new mongoose.Types.ObjectId();
  const salesAId = new mongoose.Types.ObjectId();
  const adminBId = new mongoose.Types.ObjectId();

  const mkStaff = async (_id, fname, lname, email, tenantId, admin, perms) => {
    return Staff.create({
      _id,
      firstname: fname,
      lastname: lname,
      email,
      password: "password123",
      tenant_id: tenantId,
      admin: !!admin,
      active: true,
      permissions: perms || {},
    });
  };

  await mkStaff(adminAId, "Admin", "TenantA", "admin.a@crm-test.local", tenantAId, true, {});
  await mkStaff(viewerAId, "Viewer", "TenantA", "viewer.a@crm-test.local", tenantAId, false, {
    Customers: { "View(Global)": true },
  });
  await mkStaff(editorAId, "Editor", "TenantA", "editor.a@crm-test.local", tenantAId, false, {
    Customers: { "View(Global)": true, Create: true, Edit: true, Delete: true },
  });
  await mkStaff(salesAId, "Sales", "RepA", "sales.a@crm-test.local", tenantAId, false, {
    Customers: { "View(Global)": true },
  });
  await mkStaff(adminBId, "Admin", "TenantB", "admin.b@crm-test.local", tenantBId, true, {});

  const adminAToken = jwt.sign({ id: String(adminAId), role: "staff" }, process.env.JWT_SECRET);
  const viewerAToken = jwt.sign({ id: String(viewerAId), role: "staff" }, process.env.JWT_SECRET);
  const editorAToken = jwt.sign({ id: String(editorAId), role: "staff" }, process.env.JWT_SECRET);
  const adminBToken = jwt.sign({ id: String(adminBId), role: "staff" }, process.env.JWT_SECRET);

  // Seed Branches
  const branchMumbai = await HRMSBranch.create({ name: "Mumbai Branch", city: "Mumbai", tenant_id: tenantAId });
  const branchPune = await HRMSBranch.create({ name: "Pune Branch", city: "Pune", tenant_id: tenantAId });

  // Seed Groups
  const groupVIP = await ClientGroup.create({ name: "VIP", tenant_id: tenantAId });
  const groupWholesale = await ClientGroup.create({ name: "Wholesale", tenant_id: tenantAId });
  const groupB = await ClientGroup.create({ name: "Tenant B Group", tenant_id: tenantBId });

  // Seed Currencies
  await Currency.create([
    { name: "INR", symbol: "₹", is_default: true, tenant_id: tenantAId },
    { name: "USD", symbol: "$", is_default: false, tenant_id: tenantAId },
    { name: "INR", symbol: "₹", is_default: true, tenant_id: tenantBId },
  ]);

  // Seed Customers
  const cust1 = await Client.create({
    company: "Acme Corporation",
    customer_reference: "ACME-001",
    contact_person: "John Doe",
    phonenumber: "+91 98765 43210",
    email: "john@acme.com",
    pan_number: "ABCDE1234F",
    gst_number: "27ABCDE1234F1Z5",
    currency: "INR",
    address: "101 High St",
    city: "Mumbai",
    state: "Maharashtra",
    zip: "400001",
    country: "India",
    branch: branchMumbai._id,
    groups: [groupVIP._id],
    sales_person: salesAId,
    active: true,
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  const cust2 = await Client.create({
    company: "Beta Solutions",
    customer_reference: "BETA-002",
    contact_person: "Jane Smith",
    phonenumber: "+91 91234 56789",
    email: "jane@beta.com",
    active: false,
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  const custB = await Client.create({
    company: "Tenant B Secret Client",
    active: true,
    tenant_id: tenantBId,
    created_by: adminBId,
  });

  // Seed Contacts
  await Contact.create([
    { userid: cust1._id, firstname: "John", lastname: "Doe", email: "john@acme.com", phonenumber: "9876543210", is_primary: true, active: true },
    { userid: cust1._id, firstname: "Sarah", lastname: "Connor", email: "sarah@acme.com", phonenumber: "9876543211", is_primary: false, active: true },
    { userid: cust2._id, firstname: "Jane", lastname: "Smith", email: "jane@beta.com", is_primary: true, active: false },
    { userid: custB._id, firstname: "Bob", lastname: "B", email: "bob@b.com", is_primary: true, active: true },
  ]);

  // Seed Invoices
  await Invoice.create([
    { client: cust1._id, number: "INV-001", total: 10000, subtotal: 10000, status: "paid", tenant_id: tenantAId },
    { client: cust1._id, number: "INV-002", total: 5000, subtotal: 5000, status: "unpaid", tenant_id: tenantAId },
  ]);

  // Seed Payments
  await Payment.create([
    { invoiceid: "INV-001", customerid: cust1._id, amount: 10000, tenant_id: tenantAId },
  ]);

  console.log(`[SEED COMPLETE] Seeded 2 Tenants, Staff users, Branches, Groups, Currencies, Customers & Contacts`);

  // 4. Express Server
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "25mb" }));

  // Helper login endpoint for browser testing
  app.post("/api/auth/login", async (req, res) => {
    const { email } = req.body || {};
    const staff = await Staff.findOne({ email: String(email).trim().toLowerCase() });
    if (!staff) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET);
    return res.json({
      token,
      user: {
        _id: staff._id,
        firstname: staff.firstname,
        lastname: staff.lastname,
        email: staff.email,
        admin: staff.admin,
        permissions: staff.permissions,
        tenant_id: staff.tenant_id,
        tenant: { _id: staff.tenant_id, name: "Test Tenant" },
      },
    });
  });

  app.get("/api/auth/me", require("../middleware/auth").protect, async (req, res) => {
    const staff = await Staff.findById(req.user._id).lean();
    res.json({ user: staff });
  });

  // Mount main routes
  app.use("/api/clients", require("../routes/client_routes"));
  app.use("/api/client-groups", require("../routes/client_group_routes"));
  app.use("/api/notes", require("../routes/note_routes"));
  app.use("/api/staff", require("../routes/staff_routes"));
  app.use("/api/currencies", require("../routes/currency_routes"));
  app.use("/api/invoices", require("../routes/invoice_routes"));
  app.use("/api/payments", require("../routes/payment_routes"));
  app.use("/api/hrms/branch", require("../hrms/routes/hrms_branch_route"));

  // Health check
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, port: 5101 }));

  // Unhandled errors
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ message: err.message || "Internal server error" });
  });

  await new Promise((resolve) => {
    server = app.listen(5101, "127.0.0.1", resolve);
  });

  console.log(`[GUARD CHECK 2] Test Backend running at http://127.0.0.1:5101`);
  console.log(`[GUARD CHECK 3] Live ports :5001 and :5183 are NOT used.`);
  console.log("Tokens for testing:");
  console.log(`Tenant A Admin Token: ${adminAToken}`);
  console.log(`Tenant A Viewer Token: ${viewerAToken}`);
  console.log(`Tenant A Editor Token: ${editorAToken}`);
  console.log(`Tenant B Admin Token: ${adminBToken}`);
  console.log("==================================================================");

  return {
    mongod,
    server,
    tokens: { adminA: adminAToken, viewerA: viewerAToken, editorA: editorAToken, adminB: adminBToken },
    tenantAId,
    tenantBId,
  };
}

if (require.main === module) {
  boot().catch((err) => {
    console.error("Failed to start Customers Test Stack:", err);
    process.exit(1);
  });
}

module.exports = { boot };
