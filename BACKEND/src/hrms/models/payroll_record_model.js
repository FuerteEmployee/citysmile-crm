const mongoose = require("mongoose");

const payrollRecordSchema = new mongoose.Schema({
  type: { type: String, default: "payroll", index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // Employee's branch/store at generation time. Optional: "All Branches"
  // payroll also covers staff with no branch assigned.
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
  salaryStructureSnapshot: {
    basic: Number,
    hra: Number,
    conveyance: Number,
    medicalAllowance: Number,
    specialAllowance: Number
  },

  month: { type: Number, required: true, min: 1, max: 12, index: true },
  year: { type: Number, required: true, index: true },

  payableDays: Number,
  presentDays: Number,
  leaveDays: Number,
  unpaidLeaveDays: Number,
  // Unpaid days that weren't approved unpaid leave (no punch / Absent / the
  // missing half of a Half Day). Shown as "Absent" on the payslip.
  absentDays: Number,
  overtimeMinutes: Number,

  additions: [{
    label: String,
    amount: Number
  }],
  deductions: [{
    label: String,
    amount: Number
  }],
  // Advance / Loan repayments shown in `deductions` above — booked against the
  // AdvanceSalary balance at generation (see payroll_controller.generatePayroll).
  advanceDeductions: [{
    advanceId: { type: mongoose.Schema.Types.ObjectId, ref: "AdvanceSalary" },
    amount: Number,
  }],

  grossSalary: Number,
  netSalary: Number,

  status: {
    type: String,
    enum: ["draft", "generated", "approved", "paid", "hold"],
    default: "draft"
  },

  paymentStatus: {
    type: String,
    enum: ["Paid", "Due"],
    default: "Due"
  },

  generatedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  approvedAt: Date,
  paidAt: Date,
  payslipUrl: String,
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
}, { timestamps: true });

// Compound partial index to ensure uniqueness only for payroll records
payrollRecordSchema.index({ employeeId: 1, month: 1, year: 1 }, { unique: true, partialFilterExpression: { type: "payroll" } });

module.exports = (mongoose.models["PayrollRecord"] || mongoose.model("PayrollRecord", payrollRecordSchema, "payrollrecords"));
