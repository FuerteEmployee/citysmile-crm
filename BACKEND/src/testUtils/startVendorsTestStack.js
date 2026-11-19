// Vendors Module Test Stack
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
  console.log("STARTING VENDORS TEST STACK (In-memory DB + Backend :5101)");
  console.log("==================================================================");

  // 1. In-memory Mongo
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "crm-vendors-test-secret";
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
  const Vendor = require("../models/Vendor");
  const Purchase = require("../models/Purchase");
  const HRMSBranch = require("../hrms/models/hrms_branch_model");
  const Staff = require("../models/Staff");
  const Currency = require("../models/Currency");
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
  const fullAId = new mongoose.Types.ObjectId();
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
    Vendors: { View: true },
  });
  await mkStaff(fullAId, "FullAccess", "TenantA", "full.a@crm-test.local", tenantAId, false, {
    Vendors: { View: true, Create: true, Edit: true, Delete: true },
  });
  await mkStaff(adminBId, "Admin", "TenantB", "admin.b@crm-test.local", tenantBId, true, {});

  const adminAToken = jwt.sign({ id: String(adminAId), role: "staff" }, process.env.JWT_SECRET);
  const viewerAToken = jwt.sign({ id: String(viewerAId), role: "staff" }, process.env.JWT_SECRET);
  const fullAToken = jwt.sign({ id: String(fullAId), role: "staff" }, process.env.JWT_SECRET);
  const adminBToken = jwt.sign({ id: String(adminBId), role: "staff" }, process.env.JWT_SECRET);

  // Seed Branches
  const branchMumbai = await HRMSBranch.create({ name: "Mumbai Branch", city: "Mumbai", tenant_id: tenantAId, status: "Active" });
  const branchPune = await HRMSBranch.create({ name: "Pune Branch", city: "Pune", tenant_id: tenantAId, status: "Active" });
  const branchB = await HRMSBranch.create({ name: "Tenant B Branch", city: "Delhi", tenant_id: tenantBId, status: "Active" });

  // Seed Currencies
  await Currency.create([
    { name: "INR", symbol: "₹", is_default: true, tenant_id: tenantAId },
    { name: "USD", symbol: "$", is_default: false, tenant_id: tenantAId },
    { name: "INR", symbol: "₹", is_default: true, tenant_id: tenantBId },
  ]);

  // Seed Vendors
  const vOrion = await Vendor.create({
    company_name: "Orion Supplies Pvt Ltd",
    vendor_reference: "VEN-045",
    connect_person: "Suresh Nair",
    phone_number: "9845012345",
    address: "45 Anna Salai, Chennai, Tamil Nadu",
    email: "suresh@orionsupplies.com",
    pan_number: "AAOCS1234H",
    gst_number: "33AAOCS1234H1Z2",
    account_details: "HDFC Bank A/C 1234567890",
    sales_person: "Divya Menon",
    branch: "Mumbai Branch",
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  const vBeta = await Vendor.create({
    company_name: "Beta Tools Ltd",
    vendor_reference: "VEN-046",
    connect_person: "Rohit Sharma",
    phone_number: "9876543210",
    address: "FC Road, Pune, Maharashtra",
    email: "rohit@betatools.com",
    pan_number: "BBBBB1234F",
    gst_number: "27BBBBB1234F1Z5",
    account_details: "SBI Bank A/C 9876543210",
    sales_person: "Karan Johar",
    branch: "Pune Branch",
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  const vGamma = await Vendor.create({
    company_name: "Gamma Traders",
    vendor_reference: "VEN-047",
    connect_person: "Anil Patel",
    phone_number: "9123456780",
    address: "SG Highway, Ahmedabad, Gujarat",
    email: "anil@gammatraders.com",
    pan_number: "GGGGG1234G",
    gst_number: "24GGGGG1234G1Z3",
    account_details: "Axis Bank A/C 4567891230",
    sales_person: "Divya Menon",
    branch: "Mumbai Branch",
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  const vDeletable = await Vendor.create({
    company_name: "Deletable Vendor",
    vendor_reference: "VEN-DEL",
    connect_person: "Temporary",
    phone_number: "9000000001",
    tenant_id: tenantAId,
    created_by: adminAId,
  });

  // Seed Vendor for Tenant B
  const vTenantB = await Vendor.create({
    company_name: "B Secret Vendor",
    vendor_reference: "VEN-B-01",
    connect_person: "Secret Agent",
    phone_number: "9999999999",
    email: "secret@tenantb.com",
    pan_number: "BBBBB9999B",
    gst_number: "07BBBBB9999B1Z8",
    tenant_id: tenantBId,
    created_by: adminBId,
  });

  // Seed Purchases linked to vGamma
  await Purchase.create([
    {
      bill_no: "PB-001",
      bill_date: new Date("2026-05-01"),
      supplier_name: "Gamma Traders",
      vendor_id: vGamma._id,
      amount: 1000,
      cgst: 90,
      sgst: 90,
      total: 1180,
      payment_status: "Paid",
      tenant_id: tenantAId,
    },
    {
      bill_no: "PB-002",
      bill_date: new Date("2026-06-15"),
      supplier_name: "Gamma Traders",
      vendor_id: vGamma._id,
      amount: 500,
      igst: 90,
      total: 590,
      payment_status: "Unpaid",
      tenant_id: tenantAId,
    },
    {
      bill_no: "PB-003",
      bill_date: new Date("2026-07-20"),
      supplier_name: "Gamma Traders",
      vendor_id: vGamma._id,
      amount: 250,
      cgst: 22.5,
      sgst: 22.5,
      total: 295,
      payment_status: "Partially Paid",
      tenant_id: tenantAId,
    },
    // Cross tenant purchase linked to B Secret Vendor
    {
      bill_no: "PB-B01",
      bill_date: new Date("2026-08-01"),
      supplier_name: "B Secret Vendor",
      vendor_id: vTenantB._id,
      amount: 5000,
      total: 5900,
      payment_status: "Unpaid",
      tenant_id: tenantBId,
    },
  ]);

  // 4. Express App
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
    res.json({ user: staff, permissions: staff?.permissions || {} });
  });

  // Mount main routes
  app.use("/api/vendors", require("../routes/vendor_routes"));
  app.use("/api/purchases", require("../routes/purchase_routes"));
  app.use("/api/staff", require("../routes/staff_routes"));
  app.use("/api/currencies", require("../routes/currency_routes"));
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
  console.log(`Tenant A FullAccess Token: ${fullAToken}`);
  console.log(`Tenant B Admin Token: ${adminBToken}`);
  console.log("==================================================================");

  return {
    mongod,
    server,
    tokens: { adminA: adminAToken, viewerA: viewerAToken, fullA: fullAToken, adminB: adminBToken },
    tenantAId,
    tenantBId,
    vOrionId: vOrion._id,
    vBetaId: vBeta._id,
    vGammaId: vGamma._id,
    vDeletableId: vDeletable._id,
    vTenantBId: vTenantB._id,
  };
}

if (require.main === module) {
  boot().catch((err) => {
    console.error("Failed to start Vendors Test Stack:", err);
    process.exit(1);
  });
}

module.exports = { boot };
