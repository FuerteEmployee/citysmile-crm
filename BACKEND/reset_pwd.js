const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const Staff = require("./src/models/Staff");

async function resetPwd() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/crm", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  // Create a test user or reset superadmin
  const email = "superadmin@fuertesaas.com";
  let user = await Staff.findOne({ email });
  if (user) {
    user.password = "123456";
    await user.save();
    console.log(`Reset password for ${email} to 123456`);
    
    // verify
    const isValid = await user.matchPassword("123456");
    console.log(`Password match test for 123456: ${isValid}`);
  } else {
    console.log(`User ${email} not found.`);
  }
  
  process.exit(0);
}
resetPwd();
