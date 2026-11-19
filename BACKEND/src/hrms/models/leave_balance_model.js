const mongoose = require("mongoose");

const LeaveBalanceSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    leaveTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeaveType",
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    totalAllocated: {
      type: Number,
      default: 0,
    },
    used: {
      type: Number,
      default: 0,
    },
    pending: {
      type: Number,
      default: 0, // Leaves requested but not yet approved
    },
    carriedForward: {
      type: Number,
      default: 0,
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

LeaveBalanceSchema.virtual("available").get(function () {
  return this.totalAllocated + this.carriedForward - this.used - this.pending;
});

LeaveBalanceSchema.index({ employeeId: 1, leaveTypeId: 1, year: 1 }, { unique: true });

module.exports = (mongoose.models["LeaveBalance"] || mongoose.model("LeaveBalance", LeaveBalanceSchema));
