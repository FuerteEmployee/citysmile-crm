const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const Client = require("../models/Client");
const Contact = require("../models/Contact");
const { toE164 } = require("../utils/phoneNormalize");

dotenv.config({ path: path.join(__dirname, "../../.env") });

// One-time backfill: populate phoneE164 on every existing Client/Contact
// document from its raw phonenumber. Safe to re-run — recomputation is
// deterministic and idempotent. Never logs a full phone number, only counts
// and (for unparseable numbers) the document id, so the log itself can't
// leak personal data.
async function migrateCollection(Model, label) {
  const cursor = Model.find({
    phonenumber: { $exists: true, $ne: "" },
  }).cursor();

  let scanned = 0;
  let updated = 0;
  const unparseable = [];

  const BATCH_SIZE = 500;
  let ops = [];

  const flush = async () => {
    if (ops.length === 0) return;
    await Model.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  for await (const doc of cursor) {
    scanned += 1;
    const e164 = toE164(doc.phonenumber);
    if (e164) {
      if (doc.phoneE164 !== e164) {
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { phoneE164: e164 } },
          },
        });
        updated += 1;
      }
    } else {
      unparseable.push(String(doc._id));
    }
    if (ops.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`\n${label}: scanned ${scanned}, updated ${updated}, unparseable ${unparseable.length}`);
  if (unparseable.length > 0) {
    console.log(`${label} unparseable _ids (review manually — raw numbers not logged):`);
    console.log(unparseable.join(", "));
  }
}

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB...");

    await migrateCollection(Client, "Client");
    await migrateCollection(Contact, "Contact");

    console.log("\nDone.");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  }
}

run();
