const mongoose = require("mongoose");

const SessionLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: ["login", "logout"],
      required: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    time: {
      type: String, // HH:MM:SS
      required: true,
    },
    deviceId: {
      type: String,
      default: "",
    },
    deviceName: {
      type: String,
      default: "",
    },
    ipAddress: {
      type: String,
      default: "",
    },
    userAgent: {
      type: String,
      default: "",
    },
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    address: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Optimize queries filtering by userId and date, sorted by date/time (latest first)
SessionLogSchema.index({ userId: 1, date: -1 });
SessionLogSchema.index({ date: -1 });

module.exports = (mongoose.models["SessionLog"] || mongoose.model("SessionLog", SessionLogSchema));
