const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const Staff = require("./src/models/Staff");

async function check() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/crm", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  const staffs = await Staff.find({});
  console.log("Total staffs:", staffs.length);
  for (const s of staffs) {
    console.log(`Email: ${s.email}, Admin: ${s.admin}, SuperAdmin: ${s.is_superadmin}, PwdHash length: ${s.password ? s.password.length : 0}, is valid bcrypt hash?: ${s.password && s.password.startsWith('$2')}`);
  }
  process.exit(0);
}
check();
