const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

const fixMetaIntegrationIndex = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const MetaIntegration = require("./src/models/MetaIntegration");

    const indexes = await MetaIntegration.collection.indexes();
    console.log("Current indexes on 'metaintegrations':", indexes);

    // Drop the old unique index on tenant_id — a tenant can now connect
    // several Pages, each with its own token, so tenant_id is no longer unique.
    const hasTenantIndex = indexes.some((idx) => idx.name === "tenant_id_1");
    if (hasTenantIndex) {
      console.log("Found unique index 'tenant_id_1'. Dropping it...");
      await MetaIntegration.collection.dropIndex("tenant_id_1");
      console.log("Index 'tenant_id_1' dropped successfully.");
    } else {
      console.log("Index 'tenant_id_1' not found. It might have already been dropped.");
    }

    // Recreate indexes from the schema: non-unique tenant_id, unique page_id.
    await MetaIntegration.syncIndexes();
    console.log("Indexes synchronized:", await MetaIntegration.collection.indexes());

    process.exit(0);
  } catch (error) {
    console.error("Error fixing index:", error);
    process.exit(1);
  }
};

fixMetaIntegrationIndex();
