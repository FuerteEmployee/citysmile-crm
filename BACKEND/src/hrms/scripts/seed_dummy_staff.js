require("dotenv").config();
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const User = require("../models/user_model");

const EMAIL = "dummy.staff@example.com";
const MOBILE = "9000000000";
const PASSWORD = "Dummy@123";

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to:", mongoose.connection.host);

  const existing = await User.findOne({ $or: [{ email: EMAIL }, { mobile: MOBILE }] });
  if (existing) {
    console.log("Dummy staff already exists:", existing.email);
    await mongoose.disconnect();
    return;
  }

  const user = new User({
    name: "Dummy Staff",
    email: EMAIL,
    password: PASSWORD, // hashed automatically by the User schema's pre-save hook
    mobile: MOBILE,
    gender: "Male",
    employmentType: "Full Time",
    payType: "Monthly",
    salaryAmount: 15000,
    isActive: true,
    attendanceRequired: false,
  });

  await user.save();
  console.log("✓ Dummy staff created");
  console.log("  Email   :", EMAIL);
  console.log("  Password:", PASSWORD);

  await mongoose.disconnect();
  console.log("Done.");
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
