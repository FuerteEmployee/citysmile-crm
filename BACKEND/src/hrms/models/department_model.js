const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  description: String,
  storeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Store" }],
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  isActive: { type: Boolean, default: true },
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
}, { timestamps: true });

// Unique per tenant, not globally — different tenants can each have their own "Sales"/"SLS".
departmentSchema.index({ tenant_id: 1, name: 1 }, { unique: true });
departmentSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

// Named/collectioned distinctly from the top-level src/models/Department.js
// (a different feature — email/ticketing departments). Both used to register
// under the bare name "Department", and since the CRM one loads first in
// index.js, HRMS always got its schema back from mongoose.models["Department"]
// — silently dropping code/managerId/storeIds and breaking every populate("managerId").
module.exports = (mongoose.models["HRMSDepartment"] || mongoose.model("HRMSDepartment", departmentSchema, "hrms_departments"));
