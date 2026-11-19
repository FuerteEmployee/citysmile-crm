/**
 * fix-invoice-tenant.js
 * Run: node fix-invoice-tenant.js
 * 
 * Finds the rudraverse/trinetratechnoworld admin user,
 * shows their tenant_id vs the invoice tenant_id,
 * and optionally reassigns the invoices if they don't match.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const Invoice = require("./src/models/Invoice");
const Staff = require("./src/models/Staff");
const Client = require("./src/models/Client");

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  console.log("✅  Connected to MongoDB\n");

  // ── Find all staff at trinetratechnoworld
  const trinetraStaff = await Staff.find({
    email: { $regex: /trinetratechnoworld/i }
  }).select("_id email admin is_superadmin tenant_id");

  console.log("👤  Trinetratechnoworld staff accounts:");
  if (trinetraStaff.length === 0) {
    console.log("   NONE FOUND with @trinetratechnoworld email.");
  } else {
    trinetraStaff.forEach(s =>
      console.log(`   • ${s.email}  admin=${s.admin}  tenant_id=${s.tenant_id || "❌ MISSING"}`)
    );
  }

  // ── Invoices breakdown
  const invoiceTenantId = "6a644ea61aa686e76f53d7a2";
  const invoiceCount = await Invoice.countDocuments({ tenant_id: invoiceTenantId });
  console.log(`\n📄  Invoices under tenant ${invoiceTenantId}: ${invoiceCount}`);

  // ── Show the owner of that tenant
  const Tenant = require("./src/models/Tenant");
  const tenant = await Tenant.findById(invoiceTenantId);
  if (tenant) {
    const owner = await Staff.findById(tenant.owner_id).select("email admin tenant_id");
    console.log(`🏢  Tenant owner: ${owner?.email || "unknown"}  tenant_id=${owner?.tenant_id}`);
  }

  // ── Find ALL staff with that tenant_id to show who CAN see invoices
  const validStaff = await Staff.find({ tenant_id: new mongoose.Types.ObjectId(invoiceTenantId) })
    .select("email admin is_superadmin tenant_id");
  console.log(`\n✅  Staff who CAN currently see invoices (tenant = ${invoiceTenantId}):`);
  validStaff.forEach(s => console.log(`   • ${s.email}  admin=${s.admin}`));

  // ── Look for any staff that CANNOT see invoices (wrong or missing tenant)
  const allAdmins = await Staff.find({ admin: true }).select("email tenant_id is_superadmin");
  const blindAdmins = allAdmins.filter(s =>
    !s.is_superadmin &&
    s.tenant_id?.toString() !== invoiceTenantId
  );
  console.log(`\n❌  Admin staff who CANNOT see these invoices (wrong tenant):`);
  blindAdmins.forEach(s =>
    console.log(`   • ${s.email}  their tenant_id=${s.tenant_id || "NULL"}`)
  );

  await mongoose.disconnect();
  console.log("\n✅  Done.");
}

main().catch(err => {
  console.error("Script error:", err.message);
  process.exit(1);
});
