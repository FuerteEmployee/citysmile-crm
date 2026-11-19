const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const Staff = require("./src/models/Staff");
const Tenant = require("./src/models/Tenant");

async function testCreate() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/crm", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  const email = "new_customer@test.com";
  const password = "password123";
  
  let existing = await Staff.findOne({ email });
  if (existing) {
    await Staff.deleteOne({ email });
  }

  const owner = await Staff.create({
    firstname: "Test",
    lastname: "User",
    email,
    password, // Should be hashed by pre-save hook
    admin: true,
    active: true,
  });
  
  console.log("Owner created:", owner.email, "Hash length:", owner.password.length);
  
  const isValid = await owner.matchPassword(password);
  console.log("Password matches expected?", isValid);
  
  // Test update
  owner.password = "newpassword456";
  await owner.save();
  
  const isNewValid = await owner.matchPassword("newpassword456");
  console.log("Updated password matches expected?", isNewValid);
  
  process.exit(0);
}
testCreate();
