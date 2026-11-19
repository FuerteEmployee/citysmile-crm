const fs = require("fs");
const mongoose = require("mongoose");

async function check() {
  const envContent = fs.readFileSync(".env", "utf8");
  const match = envContent.match(/MONGO_URI=(.+)/);
  const mongoUri = match ? match[1].trim() : "mongodb://127.0.0.1:27017/crm";
  
  // Hide credentials in console output
  const safeUri = mongoUri.replace(/\/\/.*@/, "//***:***@");
  console.log("Connecting to:", safeUri);
  
  await mongoose.connect(mongoUri);
  console.log("Connected to database:", mongoose.connection.name);

  const Staff = require("./src/models/Staff");
  const HRMSUser = require("./src/hrms/models/user_model");

  const staffCount = await Staff.countDocuments();
  const hrmsUserCount = await HRMSUser.countDocuments();

  console.log("\n--- Staff Count (CRM) ---:", staffCount);
  const staff = await Staff.find({}).select("email firstname lastname tenant_id admin");
  staff.forEach(s => {
    console.log(` - ID: ${s._id} | Email: ${s.email} | Name: ${s.firstname} ${s.lastname} | Tenant: ${s.tenant_id} | Admin: ${s.admin}`);
  });

  console.log("\n--- HRMS User Count ---:", hrmsUserCount);
  const hrmsUsers = await HRMSUser.find({}).select("email name tenant_id storeId isActive attendanceRequired");
  hrmsUsers.forEach(u => {
    console.log(` - ID: ${u._id} | Email: ${u.email} | Name: ${u.name} | Tenant: ${u.tenant_id} | Active: ${u.isActive} | AttReq: ${u.attendanceRequired}`);
  });

  await mongoose.disconnect();
}

check().catch(console.error);
