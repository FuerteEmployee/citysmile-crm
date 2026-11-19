const mongoose = require("mongoose");

const hrmsBranchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Scopes this branch to one tenant deployment (see user_model.js's identical field) —
  // every list/detail/create/update/delete in hrms_branch_controller.js must filter by
  // this so different tenants sharing this backend never see each other's branches.
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  branchType: { type: mongoose.Schema.Types.ObjectId, ref: "BranchType", default: null },
  // Quotation Maker type(s) this branch serves (e.g. "Trnetra") — used to scope the
  // customer dropdown in Quotation Maker to this branch's assigned customers.
  quotationTypes: [{ type: mongoose.Schema.Types.ObjectId, ref: "QuotationType" }],
  status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
  // Branch-wise supervisors (HRMS User ids). A non-admin listed here sees and
  // approves attendance / leave / advances only for staff of the branches they
  // supervise — see utils/branchScope.js.
  supervisorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  addressLine1: { type: String },
  addressLine2: { type: String },
  addressLine3: { type: String },
  city: { type: String },
  state: { type: String },
  pincode: { type: String },
  phone: { type: String },
  email: { type: String },

  // Geo-fencing
  locationName: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  radius: { type: Number, default: 500 },   // always stored in meters
  radiusUnit: { type: String, enum: ["m", "km"], default: "m" },
  geoFenceEnabled: { type: Boolean, default: false },
}, { timestamps: true });

hrmsBranchSchema.index({ tenant_id: 1, name: 1 }, { unique: true });
hrmsBranchSchema.index({ supervisorIds: 1 });

module.exports = (mongoose.models["HRMSBranch"] || mongoose.model("HRMSBranch", hrmsBranchSchema));
