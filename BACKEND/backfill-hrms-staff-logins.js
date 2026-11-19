// One-time backfill: link every HRMS employee (User collection) that has no
// matching CRM Staff login yet — this happens for anyone created via the
// bulk "Import Employees" Excel upload before import_employees_controller.js
// was fixed to create the link automatically (single-employee creation via
// user_controller.js already did this correctly).
//
// The employee's existing bcrypt password hash is copied directly into the
// new Staff document (via the native driver, bypassing Mongoose's pre-save
// hook) rather than resetting to a default — both models hash with the same
// bcrypt(cost 10) scheme, so whatever password the employee already uses on
// the HRMS side keeps working unchanged on the CRM staff login too.
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/hrms/models/user_model");
const Staff = require("./src/models/Staff");

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const users = await User.find({}).select("+password");
  let linked = 0;
  let skipped = 0;
  const fixedEmails = [];

  for (const user of users) {
    if (!user.email || !user.password) {
      skipped++;
      continue;
    }
    const existing = await Staff.findOne({ email: user.email });
    if (existing) {
      skipped++;
      continue;
    }
    const nameParts = (user.name || "Employee").trim().split(/\s+/);
    const now = new Date();
    await Staff.collection.insertOne({
      firstname: nameParts[0] || "Employee",
      lastname: nameParts.slice(1).join(" ") || "User",
      email: user.email,
      password: user.password, // already-hashed, copied as-is — see header comment
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
      datecreated: now,
      createdAt: now,
      updatedAt: now,
    });
    fixedEmails.push(user.email);
    linked++;
  }

  console.log(`Linked ${linked} employee(s), skipped ${skipped} (already linked or missing email/password).`);
  if (fixedEmails.length) {
    console.log("Newly linked emails (existing HRMS password now works for CRM staff login too):");
    fixedEmails.forEach((e) => console.log(" -", e));
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
