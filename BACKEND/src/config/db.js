const mongoose = require("mongoose");

// Some VPS resolvers intermittently mis-resolve Atlas's dual-stack shard
// hostnames right after a restart (see the DNS override in index.js) —
// fail a connection attempt quickly instead of hanging on the driver's
// 30s default, and force IPv4 to sidestep flaky AAAA lookups.
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
  family: 4,
};

mongoose.connection.on("disconnected", () => {
  console.error("MongoDB disconnected — driver will attempt to reconnect automatically.");
});
mongoose.connection.on("reconnected", () => {
  console.log("MongoDB reconnected.");
});
mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error event:", err.message);
});

const connectDB = async (retryDelayMs = 5000) => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, CONNECT_OPTIONS);
    console.log(`MongoDB Connected`);

    // Loud, hard-to-miss reminder of which database this process is talking
    // to — .env's MONGO_URI is manually toggled between the live production
    // cluster and the local crm_dev one, so print it every single startup
    // rather than relying on remembering which line is commented out.
    const dbName = conn.connection.name || "";
    if (dbName === "crm_dev") {
      console.log("🟢 Connected to LOCAL DEV database (crm_dev) — safe to test freely.");
    }

    // Reconcile indexes for models whose unique constraints changed from
    // global (unique across all tenants) to per-tenant compound indexes.
    // syncIndexes() drops the old stale index and builds the new one.
    (async () => {
      try {
        const TicketStatus = require("../models/TicketStatus");
        const LeadStatus = require("../models/LeadStatus");
        const EstimateStatus = require("../models/EstimateStatus");
        const Staff = require("../models/Staff");
        const HrmsUser = require("../hrms/models/user_model");
        // hrms_departments still carried the old global unique name_1/code_1
        // indexes, so a second tenant's "General" department (auto-created by
        // the staff import) failed with E11000.
        const HrmsDepartment = require("../hrms/models/department_model");
        // Same stale global name_1/code_1 unique indexes as hrms_departments.
        const HrmsDesignation = require("../hrms/models/designation_model");
        // ad_account_id was globally unique; now unique per tenant so an
        // agency ad account can be shared by several client tenants.
        const MetaAdAccount = require("../models/MetaAdAccount");
        await Promise.all([
          TicketStatus.syncIndexes(),
          LeadStatus.syncIndexes(),
          EstimateStatus.syncIndexes(),
          Staff.syncIndexes(),
          HrmsUser.syncIndexes(),
          HrmsDepartment.syncIndexes(),
          HrmsDesignation.syncIndexes(),
          MetaAdAccount.syncIndexes(),
        ]);
      } catch (err) {
        console.error("Failed to sync status collection indexes:", err.message);
      }
    })();


  } catch (error) {
    // Retry with backoff instead of killing the whole process — a single
    // failed attempt right at boot (e.g. DNS not settled yet) used to take
    // the entire API down until something manually restarted it.
    console.error(`MongoDB connection error: ${error.message}. Retrying in ${retryDelayMs / 1000}s...`);
    setTimeout(() => connectDB(Math.min(retryDelayMs * 2, 60000)), retryDelayMs);
  }
};

module.exports = connectDB;
