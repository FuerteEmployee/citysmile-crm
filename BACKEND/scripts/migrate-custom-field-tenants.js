// Gives every legacy custom field (tenant_id null) an owning company, then makes
// field slugs unique per company instead of across all companies.
//
// For each unowned field it looks at which records have a value for it
// (CustomFieldValue.relid -> that record's tenant_id):
//   - one company uses it      -> the field is assigned to that company
//   - several companies use it -> the first keeps the field, every other one
//                                 gets its own copy and its values are moved
//                                 onto that copy
//   - nobody has a value yet   -> left unowned (still shared) and listed
// Indexes: { tenant_id, slug } unique + { tenant_id } are created, then the old
// global slug_1 unique index is dropped.
//
// A full JSON backup (all custom fields, the affected values, the indexes) is
// written to CRM-BACKEND/backups/ before anything changes.
//
// Usage (from CRM-BACKEND, uses MONGO_URI from .env):
//   node scripts/migrate-custom-field-tenants.js --expect-db crmdb            # dry run (default)
//   node scripts/migrate-custom-field-tenants.js --expect-db crmdb --apply    # make the change
// --expect-db must match the connected database name, so the script can't run
// against the wrong server's database by accident.
//
// Undo: restore from the backup JSON (fields + values), drop tenant_id_1_slug_1
// and tenant_id_1, and recreate slug_1 unique (only possible if no two fields
// share a slug any more, i.e. before new per-company copies are added).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const CustomField = require("../src/models/CustomField");
const CustomFieldValue = require("../src/models/CustomFieldValue");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const expectDb = args[args.indexOf("--expect-db") + 1];

// CustomField.fieldto -> model whose documents carry tenant_id
const MODEL_FOR = {
  customers: "Client", contacts: "Contact", leads: "Lead", staff: "Staff", projects: "Project",
  tasks: "Task", tickets: "Ticket", invoice: "Invoice", estimate: "Estimate", proposal: "Proposal",
  contracts: "Contract", credit_note: "CreditNote", items: "Item", expenses: "Expense",
  payments: "Payment", knowledge_base: "KBArticle", meetings: "Meeting", subscriptions: "Subscription",
  goals: "Goal", announcements: "Announcement",
};
const loadModel = (name) => {
  try { return require(`../src/models/${name}`); } catch { return null; }
};

(async () => {
  if (!args.includes("--expect-db") || !expectDb) {
    console.error("Refusing to run: pass --expect-db <database name>, e.g. --expect-db crmdb");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`Connected: database "${dbName}" on ${(mongoose.connection.host || "").split(".").slice(0, 2).join(".")}…`);
  if (dbName !== expectDb) {
    console.error(`Refusing to run: connected to "${dbName}", expected "${expectDb}".`);
    process.exit(1);
  }
  console.log(APPLY ? "MODE: APPLY (writes to the database)" : "MODE: DRY RUN (nothing is written)");

  const total = await CustomField.countDocuments();
  const legacy = await CustomField.find({ tenant_id: null }).lean();
  console.log(`Custom fields: ${total} total, ${legacy.length} without a company`);

  const plan = [];
  for (const field of legacy) {
    const values = await CustomFieldValue.find({ fieldid: field._id }).select("_id relid").lean();
    const Model = MODEL_FOR[field.fieldto] && loadModel(MODEL_FOR[field.fieldto]);
    const byTenant = new Map();
    let unresolved = 0;
    if (Model && values.length) {
      const docs = await Model.find({ _id: { $in: values.map((v) => v.relid) } }).select("_id tenant_id").lean();
      const tenantOf = new Map(docs.map((d) => [String(d._id), d.tenant_id ? String(d.tenant_id) : null]));
      for (const v of values) {
        const t = tenantOf.get(String(v.relid));
        if (!t) { unresolved++; continue; }
        if (!byTenant.has(t)) byTenant.set(t, []);
        byTenant.get(t).push(v._id);
      }
    } else unresolved = values.length;
    plan.push({ field, byTenant, unresolved, noModel: !Model });
  }

  let assign = 0, split = 0, unused = 0, copies = 0;
  for (const p of plan) {
    const tenants = [...p.byTenant.keys()];
    const label = `${p.field.fieldto}/${p.field.slug} ("${p.field.name}")`;
    if (tenants.length === 0) { unused++; console.log(`  LEAVE  ${label} — no values${p.noModel ? " (module has no company field)" : ""}${p.unresolved ? `, ${p.unresolved} values on deleted/unowned records` : ""}`); }
    else if (tenants.length === 1) { assign++; console.log(`  ASSIGN ${label} -> company ${tenants[0]} (${p.byTenant.get(tenants[0]).length} values)`); }
    else { split++; copies += tenants.length - 1; console.log(`  SPLIT  ${label} -> ${tenants.length} companies: ${tenants.map((t) => `${t} (${p.byTenant.get(t).length})`).join(", ")}`); }
    if (tenants.length && p.unresolved) console.log(`         note: ${p.unresolved} values belong to deleted/unowned records and stay on the original field`);
  }
  const indexes = await CustomField.collection.indexes();
  const hasSlugUnique = indexes.some((i) => i.name === "slug_1");
  const hasCompound = indexes.some((i) => i.name === "tenant_id_1_slug_1");
  const hasTenant = indexes.some((i) => i.name === "tenant_id_1");
  console.log(`\nSummary: assign ${assign}, split ${split} (${copies} new copies), leave shared ${unused}`);
  console.log(`Indexes: create tenant_id_1_slug_1 = ${hasCompound ? "exists" : "yes"}, create tenant_id_1 = ${hasTenant ? "exists" : "yes"}, drop slug_1 = ${hasSlugUnique ? "yes" : "already gone"}`);

  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to make these changes."); return mongoose.disconnect(); }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `custom-fields-before-tenant-migration-${dbName}-${Date.now()}.json`);
  const allValues = await CustomFieldValue.find({ fieldid: { $in: legacy.map((f) => f._id) } }).lean();
  fs.writeFileSync(backupFile, JSON.stringify({ customFields: await CustomField.find({}).lean(), indexes, values: allValues }, null, 2));
  console.log(`\nBackup written: ${backupFile}`);

  // 1) Assign owners first. Copies need the global slug index gone, so they're made after step 2.
  for (const p of plan) {
    const tenants = [...p.byTenant.keys()];
    if (tenants.length) await CustomField.updateOne({ _id: p.field._id }, { $set: { tenant_id: tenants[0] } });
  }
  // 2) Per-company uniqueness in place before the global rule is removed.
  if (!hasCompound) await CustomField.collection.createIndex({ tenant_id: 1, slug: 1 }, { unique: true, name: "tenant_id_1_slug_1" });
  if (!hasTenant) await CustomField.collection.createIndex({ tenant_id: 1 }, { name: "tenant_id_1" });
  if (hasSlugUnique) await CustomField.collection.dropIndex("slug_1");
  // 3) Other companies using a shared field get their own copy, with their values moved onto it.
  for (const p of plan) {
    const tenants = [...p.byTenant.keys()];
    for (const t of tenants.slice(1)) {
      const { _id, __v, createdAt, updatedAt, ...rest } = p.field;
      const copy = await CustomField.create({ ...rest, tenant_id: t });
      await CustomFieldValue.updateMany({ _id: { $in: p.byTenant.get(t) } }, { $set: { fieldid: copy._id } });
    }
  }
  console.log("Done.");
  console.log("Indexes now:", (await CustomField.collection.indexes()).map((i) => i.name).join(", "));
  await mongoose.disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); await mongoose.disconnect(); process.exit(1); });
