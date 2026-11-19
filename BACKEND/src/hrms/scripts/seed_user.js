require("dotenv").config();
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to:", mongoose.connection.host);

  const db = mongoose.connection.db;

  // Create the role with exact ID
  await db.collection("roles").updateOne(
    { _id: new mongoose.Types.ObjectId("69be450d5721691c322dc05b") },
    {
      $setOnInsert: {
        _id: new mongoose.Types.ObjectId("69be450d5721691c322dc05b"),
        role: "owner",
        label: "General Electronics Owner",
        description: "Store owner with full access",
        icon: "Shield",
        isSystemRole: true,
        attendanceRequired: false,
        permissions: ["*"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  console.log("✓ Role upserted");

  // Insert user directly (bypasses pre-save hook so password stays hashed)
  await db.collection("users").updateOne(
    { _id: new mongoose.Types.ObjectId("69a533b2ce7bbae2299b14ef") },
    {
      $setOnInsert: {
        _id: new mongoose.Types.ObjectId("69a533b2ce7bbae2299b14ef"),
        name: "General Electronics Owner",
        email: "admin@gmail.com",
        password: "$2b$10$IknyHFVb3FPTyTUt2jYb8.C82cJIR1jxZBmBkJVvB1oKkzIKKgcb.",
        role: new mongoose.Types.ObjectId("69be450d5721691c322dc05b"),
        storeId: new mongoose.Types.ObjectId("69f09c271a67d4d201303c6a"),
        isActive: true,
        mobile: "+919999999999",
        attendanceRequired: false,
        gender: "Male",
        bloodGroup: "B-",
        dob: new Date("2003-02-27T00:00:00.000Z"),
        avatar: "https://res.cloudinary.com/dg41yycrr/image/upload/v1778564605/screentimedp_xyzabc.jpg",
        department: new mongoose.Types.ObjectId("6a01c27fb69d5189f84d6f6f"),
        address: { current: "", permanent: "" },
        residentialPhone: "",
        lastKnownLocation: { type: "Point", coordinates: [] },
        isTrackingActive: false,
        isSalesperson: false,
        weeklyHolidays: [],
        attendanceExceptions: [],
        documents: [],
        createdAt: new Date("2026-03-02T06:52:34.044Z"),
        updatedAt: new Date("2026-06-06T11:50:48.024Z"),
        __v: 0,
      },
    },
    { upsert: true }
  );
  console.log("✓ User upserted");
  console.log("  Email   : admin@gmail.com");
  console.log("  Password: (same as production — use your existing password)");

  await mongoose.disconnect();
  console.log("Done.");
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
