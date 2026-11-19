const mongoose = require("mongoose");

const AdvanceSalarySchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["Advance Salary", "Loan"],
      default: "Advance Salary",
    },
    amount: { type: Number, required: true },
    reason: { type: String, required: true },
    notes: { type: String, default: "" },
    requestDate: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected", "Repaid"],
      default: "Pending",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Set when payroll generation deducts this advance in full from a payslip
    // and flips status to "Repaid" (see payroll_controller.generatePayroll) —
    // lets an admin trace which payroll run actually repaid a given advance.
    repaidInPayrollRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayrollRecord",
      default: null,
    },
    // Installment plan — only ever set for type: "Loan" (advance_salary_controller
    // forces this to 0 for "Advance Salary", which always deducts in full). When
    // > 0, payroll deducts this fixed amount per month instead of the whole
    // balance at once. 0 = deduct in full on the next payroll run.
    monthlyInstallmentAmount: { type: Number, default: 0 },
    // Outstanding balance — set to `amount` when approved, decremented by each
    // payroll deduction (see payroll_controller.generatePayroll). Reaching 0
    // is what flips status to "Repaid", not the first deduction.
    remainingAmount: { type: Number, default: null },
    // One entry per payroll run that deducted something against this record —
    // the full month-by-month repayment history.
    installments: {
      type: [
        {
          month: { type: Number, required: true },
          year: { type: Number, required: true },
          amount: { type: Number, required: true },
          payrollRecordId: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollRecord" },
          deductedAt: { type: Date, default: Date.now },
          // "payroll" = deducted by a payroll run; "manual" = repayment recorded by
          // an admin/supervisor (cash, bank transfer, partial payback...).
          source: { type: String, enum: ["payroll", "manual"], default: "payroll" },
          note: { type: String, default: "" },
          recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        },
      ],
      default: [],
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
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

AdvanceSalarySchema.index({ employeeId: 1, status: 1 });
AdvanceSalarySchema.index({ storeId: 1, requestDate: -1 });

module.exports = (mongoose.models["AdvanceSalary"] || mongoose.model("AdvanceSalary", AdvanceSalarySchema));
