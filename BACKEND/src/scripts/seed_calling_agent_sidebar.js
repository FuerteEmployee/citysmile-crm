const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const MainSidebar = require("../models/MainSidebar");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const ENTRY = { title: "Calling Agent", url: "/admin/calling-agent", icon: "PhoneCall", group: "Main" };

const seedCallingAgentSidebar = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB...");

    const existing = await MainSidebar.findOne({ url: ENTRY.url });
    if (existing) {
      console.log('Skipping — "Calling Agent" entry already exists.');
      process.exit(0);
    }

    const lastMainItem = await MainSidebar.findOne({ group: "Main" }).sort("-order");
    const order = lastMainItem ? lastMainItem.order + 1 : 1;

    await MainSidebar.create({ ...ENTRY, order });
    console.log(`✓ Created sidebar entry: "${ENTRY.title}" -> ${ENTRY.url} (order ${order})`);

    console.log("Done.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding calling agent sidebar entry:", error.message);
    process.exit(1);
  }
};

seedCallingAgentSidebar();
