const mongoose = require("mongoose");

const salaryStructureSchema = new mongoose.Schema({
  type: { type: String, default: "structure", index: true },
  name: { type: String, required: true },
  basic: { type: Number, required: true, min: 0 },
  hra: { type: Number, default: 0 },
  conveyance: { type: Number, default: 0 },
  medicalAllowance: { type: Number, default: 0 },
  specialAllowance: { type: Number, default: 0 },
  pfApplicable: { type: Boolean, default: false },
  // How payroll applies PF (see payroll_controller.generatePayroll):
  //   fixed_monthly — full PF amount every month, regardless of attendance
  //   per_day       — PF scaled by payable days (amount ÷ days in month × payable days)
  // "per_day" is the default because it's what payroll always did before this field existed.
  pfMode: { type: String, enum: ["fixed_monthly", "per_day"], default: "per_day" },
  // PF % of Basic used when no fixed PF amount is set (statutory default 12%).
  pfRate: { type: Number, default: 12, min: 0, max: 100 },
  esicApplicable: { type: Boolean, default: false },
  professionalTax: { type: Number, default: 0 },
  standardDeductions: [{
    name: String,
    amount: Number
  }],
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Compound partial index to ensure name uniqueness only for structures
salaryStructureSchema.index({ name: 1 }, { unique: true, partialFilterExpression: { type: "structure" } });

salaryStructureSchema.virtual("grossTemplate").get(function() {
  return this.basic + this.hra + this.conveyance + this.medicalAllowance + this.specialAllowance;
});

module.exports = (mongoose.models["SalaryStructure"] || mongoose.model("SalaryStructure", salaryStructureSchema, "salarystructures"));
