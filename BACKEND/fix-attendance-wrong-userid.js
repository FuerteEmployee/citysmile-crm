// One-time data fix: some Attendance records were saved with a CRM Staff._id
// in their `userId` field instead of the correct HRMS User._id, because
// attendance_controller.js's `req.user.userId || req.user.id` fallback
// (added when fixing the JWT shape mismatch) used the Staff._id directly —
// a different collection/document, not interchangeable with User._id. Now
// that auth_middleware.js's protect() resolves the correct User._id up
// front for every request, this backfills the records already written
// with the wrong id before that fix existed.
require("dotenv").config();
const mongoose = require("mongoose");
const Attendance = require("./src/hrms/models/attendance_model");
const Staff = require("./src/models/Staff");
const User = require("./src/hrms/models/user_model");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const records = await Attendance.find({}).lean();
  let fixed = 0;
  let alreadyCorrect = 0;
  let unresolvable = 0;

  for (const rec of records) {
    const asUser = await User.findById(rec.userId).select("_id");
    if (asUser) {
      alreadyCorrect++;
      continue;
    }
    const asStaff = await Staff.findById(rec.userId).select("email");
    if (!asStaff?.email) {
      unresolvable++;
      console.log(`Unresolvable: attendance ${rec._id} — userId ${rec.userId} matches neither User nor Staff`);
      continue;
    }
    const correctUser = await User.findOne({ email: asStaff.email }).select("_id");
    if (!correctUser) {
      unresolvable++;
      console.log(`Unresolvable: attendance ${rec._id} — Staff ${asStaff.email} has no linked HRMS User`);
      continue;
    }
    await Attendance.collection.updateOne(
      { _id: rec._id },
      { $set: { userId: correctUser._id } }
    );
    console.log(`Fixed attendance ${rec._id}: ${rec.userId} -> ${correctUser._id} (${asStaff.email})`);
    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}, already correct: ${alreadyCorrect}, unresolvable: ${unresolvable}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
