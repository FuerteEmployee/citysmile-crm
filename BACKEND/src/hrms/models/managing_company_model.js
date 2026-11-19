const mongoose = require("mongoose");

const ManagingCompanySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    // Set when this company stands for an HRMS branch — Setup > Staff's
    // "Salary Managed By: Branch" picks a branch, and the settlement ledger
    // keeps grouping by ManagingCompany (see utils/branchManagingCompany.js).
    hrmsBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSBranch",
      default: null,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
  },
  { timestamps: true }
);

// Unique per tenant, not globally.
ManagingCompanySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

module.exports = (mongoose.models["ManagingCompany"] || mongoose.model("ManagingCompany", ManagingCompanySchema));
