const mongoose = require("mongoose");

const SalarySettlementRecordSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    salespersonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesperson",
      default: null,
    },
    managingCompanyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ManagingCompany",
      required: true,
    },
    month: {
      type: Number,
      min: 1,
      max: 12,
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    decidedSalary: {
      type: Number,
      required: true,
      min: 0,
    },
    targetAmount: {
      type: Number,
      default: null,
    },
    achievedRevenue: {
      type: Number,
      default: null,
    },
    // Estimated salary based on formula: decidedSalary * (achievedRevenue / targetAmount)
    // null if no target set (G1 guard)
    computedActualSalary: {
      type: Number,
      default: null,
    },
    // HR-entered brand slip amount — authoritative, required before settlement
    // null until entered
    brandSlipAmount: {
      type: Number,
      default: null,
    },
    // Variance = brandSlipAmount - decidedSalary (computed once brandSlipAmount is set)
    variance: {
      type: Number,
      default: null,
    },
    // Settlement amount = round(abs(variance)), no cap
    settlementAmount: {
      type: Number,
      default: null,
    },
    // Direction of the settlement
    direction: {
      type: String,
      enum: ["employee_to_ge", "ge_to_employee", "none"],
      default: "none",
    },
    // Workflow state
    status: {
      type: String,
      enum: ["pending_slip", "pending_settlement", "settled"],
      default: "pending_slip",
    },
    // Flags for edge cases (G1, G4)
    flags: {
      noTargetSet: { type: Boolean, default: false },
      branchScopeMismatch: { type: Boolean, default: false },
    },
    // Final slip generation
    finalSlipGenerated: { type: Boolean, default: false },
    finalSlipGeneratedAt: { type: Date, default: null },
    finalSlipRef: { type: String, default: null }, // reference/ID of the generated slip
    // Settlement tracking
    settledAt: { type: Date, default: null },
    settledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: { type: String, default: "" },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
  },
  { timestamps: true }
);

// Unique index for (employeeId, month, year) — used for upsert with G2 filter
SalarySettlementRecordSchema.index(
  { employeeId: 1, month: 1, year: 1 },
  { unique: true }
);

module.exports = (mongoose.models["SalarySettlementRecord"] || mongoose.model("SalarySettlementRecord", SalarySettlementRecordSchema
));
