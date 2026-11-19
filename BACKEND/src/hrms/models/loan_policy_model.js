const mongoose = require("mongoose");

// Per-company loan limits by monthly salary slab — e.g. ₹20,000–35,000 salary
// → max ₹3,00,000 loan. Enforced on loan requests and approvals in
// advance_salary_controller.js. A salary no slab covers falls back to
// salary × LOAN_SALARY_MULTIPLE (default 10).
const LoanPolicySchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    slabs: {
      type: [
        {
          minSalary: { type: Number, required: true, min: 0 },
          maxSalary: { type: Number, default: null }, // null = and above
          maxLoan: { type: Number, required: true, min: 1 },
        },
      ],
      default: [],
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

LoanPolicySchema.index({ tenant_id: 1 }, { unique: true });

module.exports = mongoose.models["LoanPolicy"] || mongoose.model("LoanPolicy", LoanPolicySchema);
