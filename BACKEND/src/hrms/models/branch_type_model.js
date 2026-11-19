const mongoose = require("mongoose");

const branchTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Scopes this branch type to one tenant deployment — see hrms_branch_model.js's
  // identical field. Every list/detail/create/update/delete in branch_type_controller.js
  // must filter by this so different tenants sharing this backend never see each
  // other's branch types.
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  description: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

branchTypeSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

module.exports = (mongoose.models["BranchType"] || mongoose.model("BranchType", branchTypeSchema));
