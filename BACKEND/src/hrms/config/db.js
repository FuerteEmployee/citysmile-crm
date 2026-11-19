const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 30_000,
      socketTimeoutMS: 45_000,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB:", err.message);
    if (process.env.VERCEL !== "1") {
      process.exit(1);
    }
  }
};

module.exports = connectDB;
