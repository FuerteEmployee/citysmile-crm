const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const MainSidebar = require("../models/MainSidebar");

dotenv.config({ path: path.join(__dirname, "../../.env") });

// One entry point into the Quotation module — Dashboard/Create Quotation/
// Quotations live as an internal sub-sidebar INSIDE that page (like CustomerView.tsx),
// not as separate global sidebar links.
const ENTRY = { title: "Quotations", url: "/admin/quotations", icon: "FileBarChart", group: "Sales" };

const seedQuotationSidebar = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB...");

    // Remove the earlier flat 3-item attempt.
    const removed = await MainSidebar.deleteMany({
      group: "Sales",
      title: { $in: ["Dashboard", "Create Quotation", "Quotations"] },
      url: { $regex: "^/admin/quotations" },
    });
    console.log(`Removed ${removed.deletedCount} old flat entries.`);

    const existing = await MainSidebar.findOne({ url: ENTRY.url, group: "Sales" });
    if (existing) {
      console.log('Skipping — "Quotations" entry already exists.');
      process.exit(0);
    }

    const lastSalesItem = await MainSidebar.findOne({ group: "Sales" }).sort("-order");
    const order = lastSalesItem ? lastSalesItem.order + 1 : 1;

    await MainSidebar.create({ ...ENTRY, order });
    console.log(`✓ Created single sidebar entry: "${ENTRY.title}" -> ${ENTRY.url} (order ${order})`);

    console.log("Done.");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding quotation sidebar entry:", error.message);
    process.exit(1);
  }
};

seedQuotationSidebar();
