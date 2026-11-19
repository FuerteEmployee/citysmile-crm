const mongoose = require("mongoose");

const bankDetailSchema = new mongoose.Schema(
  {
    bankName: {
      type: String,
      trim: true,
    },
    accountHolderName: {
      type: String,
      trim: true,
    },
    accountNumber: {
      type: String,
      trim: true,
    },
    ifscCode: {
      type: String,
      trim: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSBranch",
    },
    active: {
      type: Boolean,
      default: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const BankDetail = mongoose.model("BankDetail", bankDetailSchema);

module.exports = BankDetail;
