// One-time backfill for the Setup > Staff / HRMS > Staff Directory unification:
//
// 1. For every Staff (src/models/Staff.js) with no matching HRMS User
//    (src/hrms/models/user_model.js) by email, create the missing HRMS
//    employee profile — copying the already-bcrypt-hashed Staff password
//    directly via the native driver (bypassing Mongoose's pre-save hook),
//    the same technique used by resync-hrms-staff-passwords.js, since both
//    models hash with the same bcrypt(cost 10) scheme. No plaintext needed,
//    no password resets.
// 2. For every HRMS User with no matching Staff by email, create the
//    missing Staff login — same technique, mirrors backfill-hrms-staff-logins.js.
// 3. For every already-matching pair (by email), set the new explicit
//    cross-link fields (Staff.hrms_user_id / User.staffId) so future syncs
//    in staff_controller.js use the fast id-based lookup instead of an
//    email scan.
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

  const staffList = await Staff.find({});
  const userList = await User.find({});
  const userByEmail = new Map(userList.map((u) => [u.email, u]));
  const staffByEmail = new Map(staffList.map((s) => [s.email, s]));

  let createdUsers = 0;
  let createdStaff = 0;
  let linked = 0;
  let skipped = 0;

  // 1. Staff -> missing User
  for (const staff of staffList) {
    const match = userByEmail.get(staff.email);
    if (!match) {
      console.log(`[create HRMS user] ${staff.email} (${staff.firstname} ${staff.lastname})`);
      if (!DRY_RUN) {
        const now = new Date();
        const result = await User.collection.insertOne({
          name: `${staff.firstname} ${staff.lastname}`.trim(),
          email: staff.email,
          password: staff.password, // already-hashed, copied as-is
          mobile: staff.phonenumber || "",
          isActive: staff.active !== false,
          isTrackingActive: false,
          attendanceRequired: true,
          staffId: staff._id,
          weeklyHolidays: [],
          attendanceExceptions: [],
          documents: [],
          createdAt: now,
          updatedAt: now,
        });
        await Staff.collection.updateOne({ _id: staff._id }, { $set: { hrms_user_id: result.insertedId } });
      }
      createdUsers++;
      continue;
    }

    // Already matched by email — wire up the explicit cross-link fields.
    if (!DRY_RUN) {
      await Staff.collection.updateOne({ _id: staff._id }, { $set: { hrms_user_id: match._id } });
      await User.collection.updateOne({ _id: match._id }, { $set: { staffId: staff._id } });
    }
    linked++;
  }

  // 2. User -> missing Staff
  for (const user of userList) {
    if (staffByEmail.has(user.email)) {
      skipped++;
      continue;
    }
    console.log(`[create Staff login] ${user.email} (${user.name})`);
    if (!DRY_RUN) {
      const nameParts = (user.name || "Employee").trim().split(/\s+/);
      const now = new Date();
      const result = await Staff.collection.insertOne({
        firstname: nameParts[0] || "Employee",
        lastname: nameParts.slice(1).join(" ") || "User",
        email: user.email,
        password: user.password, // already-hashed, copied as-is
        phonenumber: user.mobile || "",
        admin: false,
        is_superadmin: false,
        is_hrms_staff: true,
        active: user.isActive !== false,
        permissions: {},
        departments: [],
        default_language: "System Default",
        direction: "System Default",
        two_factor_auth_enabled: 0,
        notification_sound: "default",
        hrms_user_id: user._id,
        datecreated: now,
        createdAt: now,
        updatedAt: now,
      });
      await User.collection.updateOne({ _id: user._id }, { $set: { staffId: result.insertedId } });
    }
    createdStaff++;
  }

  console.log(`\nDone. Created ${createdUsers} HRMS user(s), created ${createdStaff} Staff login(s), linked ${linked} existing pair(s), skipped ${skipped} (already had both).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
