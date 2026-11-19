const mongoose = require("mongoose");

const EmployeeRouteSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    startTime: {
      type: Date,
      default: Date.now,
    },
    endTime: {
      type: Date,
    },
    startAddress: {
      type: String,
      default: "",
    },
    endAddress: {
      type: String,
      default: "",
    },
    path: [
      {
        lat: Number,
        lng: Number,
        timestamp: { type: Date, default: Date.now },
        speed: Number,
        accuracy: Number,
        batteryLevel: Number,
        activityType: { type: String, enum: ["moving", "stationary"], default: "stationary" },
        visitId: { type: mongoose.Schema.Types.ObjectId, ref: "VisitLog" },
      },
    ],
    totalDistance: {
      type: Number, // in meters
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sessionId: {
      type: String,
      required: false,
    },
  },
  { timestamps: true }
);

EmployeeRouteSchema.index({ employeeId: 1, date: 1 });

const EmployeeRoute = (mongoose.models["EmployeeRoute"] || mongoose.model("EmployeeRoute", EmployeeRouteSchema));

// Drop the legacy sessionId_1 unique index if it still exists.
// Uniqueness is now enforced by the { employeeId, date } compound index.
mongoose.connection.once("open", async () => {
  try {
    await EmployeeRoute.collection.dropIndex("sessionId_1");
  } catch {
    // Index doesn't exist or already dropped — nothing to do.
  }
});

module.exports = EmployeeRoute;
