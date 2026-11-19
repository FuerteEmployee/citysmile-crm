require("dotenv").config();
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Role = require("../models/role_model");
const User = require("../models/user_model");

const ADMIN_EMAIL = "admin@screentime.com";
const ADMIN_PASSWORD = "Admin@1234";
const ADMIN_NAME = "Super Admin";

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to:", mongoose.connection.host);

  // 1. Create admin role if not exists
  let role = await Role.findOne({ role: "admin" });
  if (!role) {
    role = await Role.create({
      role: "admin",
      label: "Admin",
      description: "Full system access",
      icon: "Shield",
      isSystemRole: true,
      attendanceRequired: false,
      permissions: ["*"],
    });
    console.log("✓ Admin role created");
  } else {
    console.log("✓ Admin role already exists");
  }

  // 2. Create admin user if not exists
  const existing = await User.findOne({ email: ADMIN_EMAIL });
  if (existing) {
    console.log("✓ Admin user already exists:", ADMIN_EMAIL);
  } else {
    await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: role._id,
      isActive: true,
      attendanceRequired: false,
    });
    console.log("✓ Admin user created");
    console.log("  Email   :", ADMIN_EMAIL);
    console.log("  Password:", ADMIN_PASSWORD);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
