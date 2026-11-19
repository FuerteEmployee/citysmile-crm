const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const migrate = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/crm";
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB...");

    const itemsCollection = mongoose.connection.db.collection("items");
    const itemsToMigrate = await itemsCollection.find({
      $or: [
        { name: { $exists: false } },
        { name: null },
        { name: "" }
      ]
    }).toArray();

    console.log(`Found ${itemsToMigrate.length} item(s) requiring name migration.`);

    let updatedCount = 0;
    for (const item of itemsToMigrate) {
      const oldDesc = item.description || "Unnamed Item";
      await itemsCollection.updateOne(
        { _id: item._id },
        { 
          $set: { name: oldDesc },
          $setOnInsert: { quantity: item.quantity || 1, amount: item.amount || 0 }
        }
      );
      updatedCount++;
    }

    console.log(`✓ Successfully migrated ${updatedCount} item(s) setting name = description.`);
    process.exit(0);
  } catch (error) {
    console.error("Migration error:", error);
    process.exit(1);
  }
};

migrate();
