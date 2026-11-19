require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const Staff    = require("./src/models/Staff");
  const Client   = require("./src/models/Client");
  const Item     = require("./src/models/Item");
  const Estimate = require("./src/models/Estimate");
  const Invoice  = require("./src/models/Invoice");
  const Payment  = require("./src/models/Payment");
  const CreditNote = require("./src/models/CreditNote");

  // Pick first staff and tenant
  const staff = await Staff.findOne();
  if (!staff) { console.error("No staff found — login first to create a staff account."); process.exit(1); }
  const tenantId = staff.tenant_id;
  const staffId  = staff._id;
  console.log("Using staff:", staff.email, "| tenant:", tenantId);

  // Pick or create a sample client
  let client = await Client.findOne(tenantId ? { tenant_id: tenantId } : {});
  if (!client) {
    client = await Client.create({
      company: "Acme Corp",
      phonenumber: "9876543210",
      country: "India",
      active: true,
      tenant_id: tenantId,
      created_by: staffId,
    });
    console.log("Created client: Acme Corp");
  } else {
    console.log("Using client:", client.company);
  }

  const now = new Date();
  const ts  = Date.now();

  // ── 1. Item ────────────────────────────────────────────────────
  let item = await Item.findOne(tenantId ? { tenant_id: tenantId } : {});
  if (!item) {
    item = await Item.create({
      description: "Web Development Services",
      long_description: "Full-stack web development — design, build, deploy.",
      rate: 5000,
      unit: "hour",
      group: "Services",
      tenant_id: tenantId,
    });
    console.log("✓ Item created:", item.description);
  } else {
    console.log("  Item already exists:", item.description);
  }

  // ── 2. Estimate ────────────────────────────────────────────────
  const estNum = `EST-SEED-${ts}`;
  let estimate = await Estimate.findOne({ number: estNum });
  if (!estimate) {
    estimate = await Estimate.create({
      client: client._id,
      number: estNum,
      date: now,
      expirydate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      status: "sent",
      subtotal: 15000,
      total: 15000,
      notes: "Estimate for Q3 web development project.",
      items: [
        { description: "Web Development Services", qty: 3, rate: 5000, tax: 0 },
      ],
      created_by: staffId,
      tenant_id: tenantId,
    });
    console.log("✓ Estimate created:", estNum);
  } else {
    console.log("  Estimate already exists:", estNum);
  }

  // ── 3. Invoice ─────────────────────────────────────────────────
  const invNum = `INV-SEED-${ts}`;
  let invoice = await Invoice.findOne({ number: invNum });
  if (!invoice) {
    invoice = await Invoice.create({
      client: client._id,
      number: invNum,
      date: now,
      duedate: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
      status: "unpaid",
      subtotal: 25000,
      total: 25000,
      notes: "Invoice for Phase 1 development.",
      items: [
        { description: "UI/UX Design", qty: 2, rate: 8000, tax: 0 },
        { description: "Backend API", qty: 1, rate: 9000, tax: 0 },
      ],
      created_by: staffId,
      tenant_id: tenantId,
    });
    console.log("✓ Invoice created:", invNum);
  } else {
    console.log("  Invoice already exists:", invNum);
  }

  // ── 4. Payment ─────────────────────────────────────────────────
  const existingPayment = await Payment.findOne({ invoice: invoice._id });
  if (!existingPayment) {
    await Payment.create({
      invoice: invoice._id,
      amount: 10000,
      date: now,
      paymentmode: "Bank Transfer",
      transactionid: `TXN-${ts}`,
      tenant_id: tenantId,
    });
    console.log("✓ Payment created: ₹10,000 against", invNum);
  } else {
    console.log("  Payment already exists for", invNum);
  }

  // ── 5. Credit Note ─────────────────────────────────────────────
  const CreditNoteModel = mongoose.models.CreditNote || require("./src/models/CreditNote");
  const cnNum = `CN-SEED-${ts}`;
  let cn = await CreditNoteModel.findOne({ number: cnNum });
  if (!cn) {
    await CreditNoteModel.create({
      client: client._id,
      number: cnNum,
      date: now,
      subtotal: 5000,
      total: 5000,
      status: 1,
      reference: invNum,
      notes: "Partial credit against invoice " + invNum,
      items: [
        { description: "Discount on services", qty: 1, rate: 5000, tax: 0 },
      ],
      created_by: staffId,
      tenant_id: tenantId,
    });
    console.log("✓ Credit Note created:", cnNum);
  } else {
    console.log("  Credit Note already exists:", cnNum);
  }

  console.log("\nDone! Refresh the pages to see the sample data.");
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
