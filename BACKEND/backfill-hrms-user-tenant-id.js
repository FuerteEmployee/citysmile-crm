// One-time backfill: every HRMS `User` doc created before tenant scoping existed
// has tenant_id === null/undefined. For each one with a linked Staff (via staffId,
// falling back to matching email), copy tenant_id from that Staff doc — the same
// source of truth staff_controller.js's linkHrmsProfile now stamps on create.
//
// Pass --dry-run to only print what would happen, without writing anything.
require("dotenv").config();
const mongoose = require("mongoose");
const Staff = require("./src/models/Staff");
const User = require("./src/hrms/models/user_model");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(DRY_RUN ? "Running in --dry-run mode (no writes).\n" : "Running for real — writes will be committed.\n");

  const users = await User.find({ $or: [{ tenant_id: null }, { tenant_id: { $exists: false } }] });
  const staffList = await Staff.find({});
  const staffById = new Map(staffList.map((s) => [String(s._id), s]));
  const staffByEmail = new Map(staffList.map((s) => [s.email, s]));

  let updated = 0;
  let noLinkedStaff = 0;
  let alreadyNull = 0;

  for (const user of users) {
    const linkedStaff = (user.staffId && staffById.get(String(user.staffId))) || staffByEmail.get(user.email);
    if (!linkedStaff) {
      noLinkedStaff++;
      continue;
    }
    if (!linkedStaff.tenant_id) {
      alreadyNull++;
      continue;
    }
    console.log(`[set tenant_id] ${user.email} -> ${linkedStaff.tenant_id}`);
    if (!DRY_RUN) {
      await User.collection.updateOne(
        { _id: user._id },
        { $set: { tenant_id: linkedStaff.tenant_id, staffId: user.staffId || linkedStaff._id } },
      );
    }
    updated++;
  }

  console.log(`\nDone. Updated ${updated} user(s), ${noLinkedStaff} had no linked Staff, ${alreadyNull} linked Staff had no tenant_id either.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
