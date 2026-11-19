require("dotenv").config();
const mongoose = require("mongoose");

async function fix() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected\n");

  const Client   = require("./src/models/Client");
  const Item     = require("./src/models/Item");
  const Estimate = require("./src/models/Estimate");
  const Invoice  = require("./src/models/Invoice");
  const Payment  = require("./src/models/Payment");
  const CreditNote = require("./src/models/CreditNote");
  const Staff    = require("./src/models/Staff");

  // Find the client that was used
  const client = await Client.findOne({ company: "Fuerte Developers" });
  if (!client) { console.log("Client 'Fuerte Developers' not found."); process.exit(1); }
  console.log("Client found:", client.company, "| tenant_id:", client.tenant_id);

  // Also find all tenants with active data (admins with tenant_id)
  const adminStaff = await Staff.find({ admin: true, tenant_id: { $exists: true, $ne: null } }).select("email tenant_id");
  console.log("\nAll admin users with tenant_id:");
  adminStaff.forEach(s => console.log(` ${s.email} → ${s.tenant_id}`));

  // Find which tenant owns "Fuerte Developers" client
  const tenantId = client.tenant_id;
  if (!tenantId) {
    console.log("\nClient has no tenant_id. Checking all existing leads/invoices to find active tenant...");
    const Invoice2 = mongoose.models.Invoice;
    const anyInvoice = await Invoice2.findOne({ tenant_id: { $exists: true, $ne: null } });
    console.log("Any invoice with tenant_id:", anyInvoice?.number, anyInvoice?.tenant_id);
    const anyLead = await mongoose.model('Lead', new mongoose.Schema({}, { strict: false })).findOne({ tenant_id: { $exists: true, $ne: null } }).catch(() => null);
    console.log("Any lead with tenant_id:", anyLead?.name, anyLead?.tenant_id);
  }

  // Show seeded records
  const seeded = await Estimate.find({ number: /SEED/ });
  console.log("\nSeeded estimates:", seeded.map(e => ({ num: e.number, tenant: e.tenant_id })));
  const seededInv = await Invoice.find({ number: /SEED/ });
  console.log("Seeded invoices:", seededInv.map(i => ({ num: i.number, tenant: i.tenant_id })));
  const seededCN = await CreditNote.find({ number: /SEED/ });
  console.log("Seeded credit notes:", seededCN.map(c => ({ num: c.number, tenant: c.tenant_id })));

  // If we have a tenant_id from the client, patch all seeded records
  if (tenantId) {
    console.log("\n→ Patching seeded records with tenant_id:", tenantId);
    const r1 = await Estimate.updateMany({ number: /SEED/ }, { $set: { tenant_id: tenantId } });
    console.log("Estimates updated:", r1.modifiedCount);
    const r2 = await Invoice.updateMany({ number: /SEED/ }, { $set: { tenant_id: tenantId } });
    console.log("Invoices updated:", r2.modifiedCount);
    const r3 = await CreditNote.updateMany({ number: /SEED/ }, { $set: { tenant_id: tenantId } });
    console.log("Credit Notes updated:", r3.modifiedCount);
    // Payments reference the seeded invoice
    if (seededInv.length > 0) {
      const invIds = seededInv.map(i => i._id);
      const r4 = await Payment.updateMany({ invoice: { $in: invIds } }, { $set: { tenant_id: tenantId } });
      console.log("Payments updated:", r4.modifiedCount);
    }
    // Items (if it's the SAMSUNG one without tenant)
    const r5 = await Item.updateMany({ tenant_id: { $exists: false } }, { $set: { tenant_id: tenantId } });
    console.log("Items without tenant updated:", r5.modifiedCount);
    console.log("\nDone! Refresh the pages.");
  } else {
    console.log("\nClient has no tenant_id — cannot patch. Need to know which tenant is logged in.");
    console.log("Please tell me which email you are logged in as, and I'll patch the tenant_id.");
  }

  await mongoose.disconnect();
}

fix().catch(console.error);
