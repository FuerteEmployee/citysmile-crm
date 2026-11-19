require("dotenv").config();
const mongoose = require("mongoose");

const TENANT_ID = new mongoose.Types.ObjectId("6a324982a53e6d25c9682d5f");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected | tenant:", TENANT_ID);

  const Client   = require("./src/models/Client");
  const Item     = require("./src/models/Item");
  const Estimate = require("./src/models/Estimate");
  const Invoice  = require("./src/models/Invoice");
  const Payment  = require("./src/models/Payment");
  const CreditNote = require("./src/models/CreditNote");
  const Staff    = require("./src/models/Staff");

  // Get admin staff for this tenant
  const staff = await Staff.findOne({ tenant_id: TENANT_ID, admin: true });
  console.log("Using staff:", staff?.email);

  // ── Step 1: patch old seeded records ──────────────────────────
  const r1 = await Estimate.updateMany({ number: /SEED/ }, { $set: { tenant_id: TENANT_ID } });
  const r2 = await Invoice.updateMany({ number: /SEED/ }, { $set: { tenant_id: TENANT_ID } });
  const r3 = await CreditNote.updateMany({ number: /SEED/ }, { $set: { tenant_id: TENANT_ID } });
  const seededInvs = await Invoice.find({ number: /SEED/ });
  const r4 = await Payment.updateMany({ invoice: { $in: seededInvs.map(i => i._id) } }, { $set: { tenant_id: TENANT_ID } });
  console.log(`Patched old seeds → Estimates:${r1.modifiedCount} Invoices:${r2.modifiedCount} CNs:${r3.modifiedCount} Payments:${r4.modifiedCount}`);

  // ── Step 2: find or create a client for this tenant ───────────
  let client = await Client.findOne({ tenant_id: TENANT_ID });
  if (!client) {
    client = await Client.create({
      company: "Test Client Ltd",
      phonenumber: "9876543210",
      country: "India",
      active: true,
      tenant_id: TENANT_ID,
      created_by: staff?._id,
    });
    console.log("Created client:", client.company);
  } else {
    console.log("Using client:", client.company);
  }

  const ts = Date.now();
  const now = new Date();

  // ── Step 3: Item ──────────────────────────────────────────────
  const existItem = await Item.findOne({ tenant_id: TENANT_ID });
  if (!existItem) {
    const item = await Item.create({
      description: "Web Development Services",
      long_description: "Full-stack development — design, build, deploy.",
      rate: 5000,
      unit: "hour",
      group: "Services",
      tenant_id: TENANT_ID,
    });
    console.log("✓ Item created:", item.description);
  } else {
    console.log("  Item exists:", existItem.description);
  }

  // ── Step 4: Estimate ──────────────────────────────────────────
  const estNum = `EST-DEMO-${ts}`;
  const estimate = await Estimate.create({
    client: client._id,
    number: estNum,
    date: now,
    expirydate: new Date(now.getTime() + 30 * 86400000),
    status: "sent",
    subtotal: 15000,
    total: 15000,
    notes: "Demo estimate for Q3 web development.",
    items: [{ description: "Web Development", qty: 3, rate: 5000, tax: 0 }],
    created_by: staff?._id,
    tenant_id: TENANT_ID,
  });
  console.log("✓ Estimate created:", estNum);

  // ── Step 5: Invoice ───────────────────────────────────────────
  const invNum = `INV-DEMO-${ts}`;
  const invoice = await Invoice.create({
    client: client._id,
    number: invNum,
    date: now,
    duedate: new Date(now.getTime() + 15 * 86400000),
    status: "unpaid",
    subtotal: 25000,
    total: 25000,
    notes: "Demo invoice for Phase 1.",
    items: [
      { description: "UI/UX Design", qty: 2, rate: 8000, tax: 0 },
      { description: "Backend API", qty: 1, rate: 9000, tax: 0 },
    ],
    created_by: staff?._id,
    tenant_id: TENANT_ID,
  });
  console.log("✓ Invoice created:", invNum);

  // ── Step 6: Payment ───────────────────────────────────────────
  await Payment.create({
    invoice: invoice._id,
    amount: 10000,
    date: now,
    paymentmode: "Bank Transfer",
    transactionid: `TXN-DEMO-${ts}`,
    tenant_id: TENANT_ID,
  });
  console.log("✓ Payment created: 10,000 against", invNum);

  // ── Step 7: Credit Note ───────────────────────────────────────
  const cnNum = `CN-DEMO-${ts}`;
  await CreditNote.create({
    client: client._id,
    number: cnNum,
    date: now,
    subtotal: 5000,
    total: 5000,
    status: 1,
    reference: invNum,
    notes: "Partial credit against " + invNum,
    items: [{ description: "Service discount", qty: 1, rate: 5000, tax: 0 }],
    created_by: staff?._id,
    tenant_id: TENANT_ID,
  });
  console.log("✓ Credit Note created:", cnNum);

  console.log("\nAll done! Refresh the pages to see data.");
  await mongoose.disconnect();
}

run().catch(err => { console.error(err.message); process.exit(1); });
