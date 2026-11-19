const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

const fixSettingsIndex = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const Setting = require("./src/models/Setting");
    
    // Check existing indexes
    const indexes = await Setting.collection.indexes();
    console.log("Current indexes on 'settings':", indexes);

    // Drop the problematic name_1 index if it exists
    const hasNameIndex = indexes.some(idx => idx.name === "name_1");
    if (hasNameIndex) {
      console.log("Found unique index 'name_1'. Dropping it...");
      await Setting.collection.dropIndex("name_1");
      console.log("Index 'name_1' dropped successfully.");
    } else {
      console.log("Index 'name_1' not found. It might have already been dropped.");
    }

    // Optional: Just in case, try to sync indexes to make sure name_1_tenant_id_1 exists
    await Setting.syncIndexes();
    console.log("Indexes synchronized.");

    process.exit(0);
  } catch (error) {
    console.error("Error fixing index:", error);
    process.exit(1);
  }
};

fixSettingsIndex();
