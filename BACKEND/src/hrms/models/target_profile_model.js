const mongoose = require("mongoose");

const TargetProfileSchema = new mongoose.Schema(
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
    revenueTarget: {
      type: Number,
      default: 0,
    },
    marginTargetPercent: {
      type: Number,
      default: 0,
    },
    productTargets: [
      {
        categoryId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Category",
        },
        quantityTarget: {
          type: Number,
          default: 0,
        },
        revenueTarget: {
          type: Number,
          default: 0,
        },
      },
    ],
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
  },
  { timestamps: true }
);

TargetProfileSchema.index({ employeeId: 1, month: 1, year: 1 }, { unique: true });

module.exports = (mongoose.models["TargetProfile"] || mongoose.model("TargetProfile", TargetProfileSchema));
