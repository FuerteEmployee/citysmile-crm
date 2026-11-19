// One-time fix: for every HRMS employee with an existing linked CRM Staff
// login, re-sync the Staff login's password hash to match the employee's
// CURRENT HRMS password. This corrects drift caused by user_controller.js's
// updateUser previously not propagating password changes to the linked
// Staff record (fixed alongside this script) — anyone whose HRMS password
// was ever changed after their initial link was created was silently left
// with their old CRM staff login password.
//
// The hash is copied directly (native driver update, bypassing Mongoose's
// pre-save hook) rather than re-hashed, since both models already hash with
// the same bcrypt(cost 10) scheme — this requires no downtime and no
// employee needs to be told a new password.
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/hrms/models/user_model");
const Staff = require("./src/models/Staff");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({});
  let resynced = 0;
  let alreadyMatching = 0;
  let noLinkedStaff = 0;

  for (const user of users) {
    if (!user.email || !user.password) continue;
    const staff = await Staff.findOne({ email: user.email });
    if (!staff) {
      noLinkedStaff++;
      continue;
    }
    if (staff.password === user.password) {
      alreadyMatching++;
      continue;
    }
    await Staff.collection.updateOne(
      { _id: staff._id },
      { $set: { password: user.password } }
    );
    console.log(`Resynced password for ${user.email}`);
    resynced++;
  }

  console.log(`\nDone. Resynced: ${resynced}, already matching: ${alreadyMatching}, no linked Staff: ${noLinkedStaff}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
