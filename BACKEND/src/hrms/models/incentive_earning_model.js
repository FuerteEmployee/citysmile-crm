const mongoose = require("mongoose");

const IncentiveEarningSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    month: {
      type: Number, // 1-12
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    targetProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TargetProfile",
      default: null,
    },
    achievedRevenue: {
      type: Number,
      default: 0,
    },
    achievedMargin: {
      type: Number,
      default: 0,
    },
    calculatedIncentive: {
      type: Number,
      default: 0,
    },
    approvedIncentive: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid"],
      default: "pending",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

IncentiveEarningSchema.index({ employeeId: 1, month: 1, year: 1 }, { unique: true });

module.exports = (mongoose.models["IncentiveEarning"] || mongoose.model("IncentiveEarning", IncentiveEarningSchema));
