// Purchase Orders round 29 — deploy check for the LIVE database.
// NOT RUN by the developer; run it only after the owner says so.
//
// READ-ONLY. There is no --apply: round 29 needs no data change. It lists,
// per company with Purchase Orders data, what the new rules will meet:
//   S1  PO items with no series (category "") — shown as "No series" in the
//       PO Items panel until they are edited or the price list is uploaded
//       again; the saved default series (missing = "M210").
//   S4  draft POs without a customer (can't be submitted now — edit and pick
//       one); drafts with a customer PO file but no Customer PO No. (the next
//       save asks for it); the same Customer PO No. twice for one customer
//       (not cancelled) — the next save of either is refused; PO items whose
//       catalog no. doesn't fit the manual-entry rule (only matters when
//       edited by hand — the Excel upload keeps the price list's own text);
//       saved settings values that the Settings screen will now mark
//       (company / supplier phone, GSTIN, email; PO prefix; proforma
//       "valid for" 0 days).
//
// Usage (from CRM-BACKEND, uses MONGO_URI from .env):
//   node scripts/po-round29-check.js --expect-db crmdb
// --expect-db must match the connected database name.
require("dotenv").config();
const mongoose = require("mongoose");
const V = require("../src/services/poValidation");

const args = process.argv.slice(2);
const expectDb = args.includes("--expect-db") ? args[args.indexOf("--expect-db") + 1] : null;

(async () => {
  if (!expectDb) {
    console.error("Refusing to run: pass --expect-db <database name>, e.g. --expect-db crmdb");
    process.exit(1);
  }
  if (args.includes("--apply") || args.includes("--rollback")) {
    console.error("This check is read-only — there is nothing to apply.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  if (db.databaseName !== expectDb) {
    console.error(`Refusing to run: connected to "${db.databaseName}", expected "${expectDb}".`);
    process.exit(1);
  }
  console.log(`Connected to "${db.databaseName}". MODE: READ-ONLY (nothing is written)`);

  const tenants = new Set([
    ...(await db.collection("poitems").distinct("tenant_id")).map(String),
    ...(await db.collection("purchaseorders").distinct("tenant_id")).map(String),
    ...(await db.collection("posettings").distinct("tenant_id")).map(String),
  ]);
  for (const t of tenants) {
    const tid = new mongoose.Types.ObjectId(t);
    const tenant = await db.collection("tenants").findOne({ _id: tid }, { projection: { company_name: 1 } });
    console.log(`\n=== ${tenant?.company_name || "?"} (${t}) ===`);

    const items = await db.collection("poitems").countDocuments({ tenant_id: tid });
    const noSeries = await db.collection("poitems").countDocuments({ tenant_id: tid, $or: [{ category: "" }, { category: null }, { category: { $exists: false } }] });
    const series = await db.collection("poitems").aggregate([{ $match: { tenant_id: tid, category: { $nin: ["", null] } } }, { $group: { _id: "$category", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
    console.log(`S1 PO items: ${items}; with no series: ${noSeries}; series: ${series.map((s) => `${s._id} (${s.n})`).join(", ") || "-"}`);
    const badSeriesNames = series.filter((s) => V.seriesName(s._id).error).map((s) => s._id);
    if (badSeriesNames.length) console.log(`   series names outside the new rule (kept; renamed on the next upload): ${badSeriesNames.join(" | ")}`);
    const codes = await db.collection("poitems").find({ tenant_id: tid, item_code: { $exists: true, $ne: "" } }, { projection: { item_code: 1 } }).toArray();
    const badCodes = codes.filter((c) => V.catalogNo(c.item_code).error);
    console.log(`S4 catalog nos. outside the manual-entry rule: ${badCodes.length}${badCodes.length ? ` e.g. ${badCodes.slice(0, 5).map((c) => c.item_code).join(" | ")}` : ""}`);

    const noCustomer = await db.collection("purchaseorders").countDocuments({ tenant_id: tid, type: "purchase", status: "draft", customer: { $exists: false } });
    const fileNoNumber = await db.collection("purchaseorders").countDocuments({ tenant_id: tid, status: { $ne: "cancelled" }, "customer_po_file.url": { $exists: true }, $or: [{ customer_po_number: { $exists: false } }, { customer_po_number: "" }] });
    const dups = await db.collection("purchaseorders").aggregate([
      { $match: { tenant_id: tid, type: "purchase", status: { $ne: "cancelled" }, customer: { $exists: true }, customer_po_number: { $nin: ["", null] } } },
      { $group: { _id: { c: "$customer", n: { $toLower: "$customer_po_number" } }, pos: { $push: "$po_number" }, k: { $sum: 1 } } },
      { $match: { k: { $gt: 1 } } },
    ]).toArray();
    console.log(`S4 drafts without a customer: ${noCustomer}; POs with a customer PO file but no Customer PO No.: ${fileNoNumber}; duplicate Customer PO No. per customer: ${dups.length}${dups.length ? ` (${dups.map((d) => d.pos.join("+")).join("; ")})` : ""}`);

    const s = await db.collection("posettings").findOne({ tenant_id: tid });
    if (!s) {
      console.log("PO Settings: not saved yet (defaults; default series M210)");
      continue;
    }
    const notes = [];
    const chk = (r, what) => r.error && notes.push(`${what}: ${r.error}`);
    chk(V.phone(s.supplier?.phone), "supplier phone");
    chk(V.phone(s.supplier?.whatsapp), "supplier WhatsApp");
    chk(V.gstin(s.supplier?.gstin), "supplier GSTIN");
    chk(V.email(s.supplier?.email), "supplier email");
    if (s.company?.saved_at) {
      chk(V.phone(s.company?.phone), "company phone");
      chk(V.gstin(s.company?.gstin), "company GSTIN");
      chk(V.email(s.company?.email), "company email");
    }
    (s.divisions || []).forEach((d) => chk(V.poPrefix(d.purchase_prefix), `division ${d.name} prefix "${d.purchase_prefix}"`));
    if (s.proforma && s.proforma.valid_days !== undefined && V.validDays(s.proforma.valid_days).error) notes.push(`proforma valid days ${s.proforma.valid_days}`);
    console.log(`PO Settings: default series ${s.default_series === undefined ? "(not saved -> M210)" : JSON.stringify(s.default_series)}`);
    console.log(notes.length ? `   values the Settings screen will mark (fix before the next save): ${notes.join("; ")}` : "   all saved values fit the new rules");
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
