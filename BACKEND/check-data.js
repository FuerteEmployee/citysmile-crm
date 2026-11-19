require("dotenv").config();
const mongoose = require("mongoose");

async function check() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected\n");

  const Item     = require("./src/models/Item");
  const Estimate = require("./src/models/Estimate");
  const Invoice  = require("./src/models/Invoice");
  const Payment  = require("./src/models/Payment");
  const CreditNote = require("./src/models/CreditNote");
  const Staff    = require("./src/models/Staff");

  const staff = await Staff.findOne({ email: "bharatfuerte@gmail.com" });
  console.log("Staff:", staff?.email, "| admin:", staff?.admin, "| tenant_id:", staff?.tenant_id, "| role:", staff?.role);

  const items = await Item.find({}).limit(3);
  console.log("\nItems (total):", await Item.countDocuments(), "| sample:", items.map(i => ({ desc: i.description, tenant: i.tenant_id })));

  const estimates = await Estimate.find({}).limit(5).populate("client", "company");
  console.log("\nEstimates (total):", await Estimate.countDocuments(), "| sample:", estimates.map(e => ({ num: e.number, status: e.status, tenant: e.tenant_id, client: e.client?.company })));

  const invoices = await Invoice.find({}).limit(5).populate("client", "company");
  console.log("\nInvoices (total):", await Invoice.countDocuments(), "| sample:", invoices.map(i => ({ num: i.number, status: i.status, tenant: i.tenant_id, client: i.client?.company })));

  const payments = await Payment.find({}).limit(5);
  console.log("\nPayments (total):", await Payment.countDocuments(), "| sample:", payments.map(p => ({ amount: p.amount, tenant: p.tenant_id, invoice: p.invoice })));

  const cns = await CreditNote.find({}).limit(5);
  console.log("\nCreditNotes (total):", await CreditNote.countDocuments(), "| sample:", cns.map(c => ({ num: c.number, total: c.total, tenant: c.tenant_id })));

  await mongoose.disconnect();
}

check().catch(err => { console.error(err); process.exit(1); });
