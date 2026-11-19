const mongoose = require("mongoose");

const designationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  level: { type: Number, default: 1 },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "HRMSDepartment" },
  isActive: { type: Boolean, default: true },
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
}, { timestamps: true });

// Unique per tenant, not globally — different tenants can each have their own "Manager"/"MGR".
designationSchema.index({ tenant_id: 1, name: 1 }, { unique: true });
designationSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

module.exports = (mongoose.models["Designation"] || mongoose.model("Designation", designationSchema));
