// Purchase Orders round 28 (Brady flow) — deploy check for the LIVE database.
// NOT RUN by the developer; run it only after the owner says so.
//
// Read-only by default (dry run). It reports, per company with the
// "purchase_orders" add-on:
//   - R1: Sales POs that exist (they become read-only; none expected —
//     Rudraverse showed "No purchase orders yet")
//   - R6: the saved Purchase PO rule (the code forces the floor on, but the
//     PO Settings screen shows what is saved)
//   - R2: POs already numbered in the old "<prefix>-<year>-0001" format (they
//     keep their numbers; new POs get "<prefix>/<nn>/<FY>")
//   - Q4: whether "Company details for PO and proforma" were ever saved
//
// --apply makes ONE optional change: rules.purchase becomes the round-28
// default (price_floor true, allow_below_list false, max_discount_pct null)
// for companies whose saved rule differs. A JSON backup of every changed
// PoSettings.rules is written to CRM-BACKEND/backups/ first.
// --rollback <backup.json> puts the saved rules back exactly.
//
// Usage (from CRM-BACKEND, uses MONGO_URI from .env):
//   node scripts/po-round28-brady-flow-check.js --expect-db crmdb                 # dry run
//   node scripts/po-round28-brady-flow-check.js --expect-db crmdb --apply         # write (asks nothing — get approval first)
//   node scripts/po-round28-brady-flow-check.js --expect-db crmdb --rollback backups/po-r28-rules-<ts>.json
// --expect-db must match the connected database name.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ROLLBACK = args.includes("--rollback") ? args[args.indexOf("--rollback") + 1] : null;
const expectDb = args.includes("--expect-db") ? args[args.indexOf("--expect-db") + 1] : null;

(async () => {
  if (!expectDb) {
    console.error("Refusing to run: pass --expect-db <database name>, e.g. --expect-db crmdb");
    process.exit(1);
  }
  if (APPLY && ROLLBACK) {
    console.error("Use --apply or --rollback, not both.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  if (db.databaseName !== expectDb) {
    console.error(`Refusing to run: connected to "${db.databaseName}", expected "${expectDb}".`);
    process.exit(1);
  }
  console.log(`Connected to "${db.databaseName}". MODE: ${APPLY ? "APPLY" : ROLLBACK ? "ROLLBACK" : "DRY RUN (nothing is written)"}`);

  if (ROLLBACK) {
    const backup = JSON.parse(fs.readFileSync(ROLLBACK, "utf8"));
    for (const row of backup.rows) {
      await db.collection("posettings").updateOne({ _id: new mongoose.Types.ObjectId(row._id) }, { $set: { "rules.purchase": row.purchase } });
      console.log(`restored rules.purchase of settings ${row._id} (tenant ${row.tenant_id})`);
    }
    await mongoose.disconnect();
    return;
  }

  const tenants = await db.collection("tenants").find({ enabled_features: "purchase_orders" }).project({ company_name: 1 }).toArray();
  const envIds = String(process.env.PURCHASE_ORDERS_TENANT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`Companies with the add-on ticked: ${tenants.length}; PURCHASE_ORDERS_TENANT_IDS: ${envIds.join(", ") || "(empty)"}`);
  const TARGET = { price_floor: true, allow_below_list: false, max_discount_pct: null };
  const toChange = [];
  for (const t of tenants) {
    const pos = db.collection("purchaseorders");
    const sales = await pos.find({ tenant_id: t._id, type: "sales" }).project({ po_number: 1, status: 1 }).toArray();
    const oldNumbers = await pos.countDocuments({ tenant_id: t._id, po_number: /-[0-9]{4}-[0-9]{4}$/ });
    const all = await pos.countDocuments({ tenant_id: t._id });
    const proformas = await db.collection("proformainvoices").countDocuments({ tenant_id: t._id });
    const s = await db.collection("posettings").findOne({ tenant_id: t._id });
    console.log(`\n${t.company_name} (${t._id}) ${envIds.includes(String(t._id)) ? "[in env]" : "[NOT in env]"}`);
    console.log(`  POs: ${all}; Sales POs (become read-only): ${sales.length}${sales.length ? " -> " + sales.map((p) => `${p.po_number} [${p.status}]`).join(", ") : ""}`);
    console.log(`  POs with old-format numbers: ${oldNumbers}; proformas: ${proformas}`);
    if (!s) {
      console.log("  PoSettings: none yet (created with the round-28 defaults on first open)");
      continue;
    }
    const pr = (s.rules && s.rules.purchase) || {};
    console.log(`  rules.purchase saved: ${JSON.stringify(pr)}`);
    console.log(`  company details saved: ${s.company && s.company.saved_at ? "yes" : "no (PDFs use the CRM company profile until saved)"}`);
    const differs = Object.entries(TARGET).some(([k, v]) => pr[k] !== v);
    if (differs) toChange.push({ _id: String(s._id), tenant_id: String(t._id), purchase: pr });
  }

  console.log(`\nSettings whose rules.purchase differ from the round-28 default: ${toChange.length}`);
  if (APPLY && toChange.length) {
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `po-r28-rules-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date(), rows: toChange }, null, 2));
    console.log(`Backup written: ${file}`);
    for (const row of toChange) {
      await db.collection("posettings").updateOne({ _id: new mongoose.Types.ObjectId(row._id) }, { $set: { "rules.purchase": { ...row.purchase, ...TARGET } } });
      console.log(`  updated settings ${row._id}`);
    }
    console.log(`Undo: node scripts/po-round28-brady-flow-check.js --expect-db ${expectDb} --rollback ${path.relative(process.cwd(), file)}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
