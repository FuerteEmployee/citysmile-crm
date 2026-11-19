// Leave types + HRMS expense categories: global unique -> unique per company.
//
//   leavetypes:             code_1 (unique)  ->  tenant_id_1_code_1 (unique)
//   hrmsexpensecategories:  name_1 (unique)  ->  tenant_id_1_name_1 (unique)
//
// Only indexes change — no document is inserted, updated or deleted. Existing
// records have no tenant_id, so they stay shared defaults every company sees.
// The new index is created BEFORE the old one is dropped, so there is no moment
// without a uniqueness rule.
//
// Usage (from CRM-BACKEND, uses MONGO_URI from .env):
//   node scripts/migrate-leavetype-expcat-tenant.js --expect-db crmdb             # dry run (default)
//   node scripts/migrate-leavetype-expcat-tenant.js --expect-db crmdb --apply     # make the change
//   node scripts/migrate-leavetype-expcat-tenant.js --expect-db crmdb --rollback  # undo
// --expect-db must match the connected database name, so the script can't run
// against the wrong server's database by accident.
const mongoose = require("mongoose");
require("dotenv").config();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ROLLBACK = args.includes("--rollback");
const expectDb = args[args.indexOf("--expect-db") + 1];

const PLAN = [
  { collection: "leavetypes", oldName: "code_1", oldKey: { code: 1 }, newName: "tenant_id_1_code_1", newKey: { tenant_id: 1, code: 1 } },
  { collection: "hrmsexpensecategories", oldName: "name_1", oldKey: { name: 1 }, newName: "tenant_id_1_name_1", newKey: { tenant_id: 1, name: 1 } },
];

(async () => {
  if (!args.includes("--expect-db") || !expectDb) {
    console.error("Refusing to run: pass --expect-db <database name>, e.g. --expect-db crmdb");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const host = (mongoose.connection.host || "").split(".").slice(0, 2).join(".");
  console.log(`Connected: database "${db.databaseName}" on ${host}…`);
  if (db.databaseName !== expectDb) {
    console.error(`Refusing to run: connected to "${db.databaseName}", expected "${expectDb}".`);
    process.exit(1);
  }
  console.log(`Mode: ${ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY RUN (nothing will be changed)"}\n`);

  for (const step of PLAN) {
    const col = db.collection(step.collection);
    const exists = (await db.listCollections({ name: step.collection }).toArray()).length > 0;
    const indexes = exists ? await col.indexes() : [];
    const has = (name) => indexes.some((i) => i.name === name);
    console.log(`[${step.collection}] documents: ${exists ? await col.countDocuments() : 0}; indexes: ${indexes.map((i) => i.name).join(", ") || "(none)"}`);

    if (ROLLBACK) {
      if (!has(step.oldName)) {
        console.log(`  create ${step.oldName} (unique)`);
        await col.createIndex(step.oldKey, { unique: true, name: step.oldName });
      }
      if (has(step.newName)) {
        console.log(`  drop ${step.newName}`);
        await col.dropIndex(step.newName);
      }
      continue;
    }

    if (!has(step.newName)) {
      console.log(`  ${APPLY ? "" : "would "}create ${step.newName} (unique)`);
      if (APPLY) await col.createIndex(step.newKey, { unique: true, name: step.newName });
    } else console.log(`  ${step.newName} already exists`);
    if (has(step.oldName)) {
      console.log(`  ${APPLY ? "" : "would "}drop ${step.oldName}`);
      if (APPLY) await col.dropIndex(step.oldName);
    } else console.log(`  ${step.oldName} already gone`);
  }

  if (APPLY || ROLLBACK) {
    console.log("\nIndexes now:");
    for (const step of PLAN) console.log(`  ${step.collection}: ${(await db.collection(step.collection).indexes()).map((i) => i.name).join(", ")}`);
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Migration failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
