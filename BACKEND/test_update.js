const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const Staff = require("./src/models/Staff");
const Tenant = require("./src/models/Tenant");

async function testUpdate() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/crm", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  const tenant = await Tenant.findOne().populate("owner_id");
  if (!tenant) {
    console.log("No tenant found.");
    process.exit(0);
  }
  
  console.log("Found tenant:", tenant.company_name);
  if (!tenant.owner_id) {
    console.log("Tenant has no owner.");
    process.exit(0);
  }
  
  const staff = await Staff.findById(tenant.owner_id._id);
  console.log("Owner email before update:", staff.email);
  
  // Simulate what updateTenant does
  staff.password = "newpass123";
  await staff.save();
  
  console.log("Password updated successfully using save().");
  
  const isMatch = await staff.matchPassword("newpass123");
  console.log("Does new password match?:", isMatch);
  
  process.exit(0);
}
testUpdate();
