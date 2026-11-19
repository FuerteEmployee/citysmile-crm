const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const MainSidebar = require("../models/MainSidebar");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const ENTRY = { title: "WhatsApp Marketing", url: "/admin/whatsapp", icon: "MessageCircle", group: "Sales", permission: "WhatsApp" };

const seedWhatsAppSidebar = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB...");

    const existing = await MainSidebar.findOne({ url: ENTRY.url });
    if (existing) {
      console.log('Skipping — "WhatsApp Marketing" entry already exists.');
      process.exit(0);
    }

    const lastSalesItem = await MainSidebar.findOne({ group: "Sales" }).sort("-order");
    const order = lastSalesItem ? lastSalesItem.order + 1 : 1;

    await MainSidebar.create({ ...ENTRY, order });
    console.log(`✓ Created sidebar entry: "${ENTRY.title}" -> ${ENTRY.url} (order ${order})`);

    console.log("Done.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding WhatsApp sidebar entry:", error.message);
    process.exit(1);
  }
};

seedWhatsAppSidebar();
