const mongoose = require("mongoose");

const ExpenseSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    category: { 
      type: String, 
      required: true,
    },
    date: { type: Date, default: Date.now },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Paid", "Rejected"],
      default: "Pending",
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Card", "UPI", "Net Banking", "Cheque"],
      default: "Cash",
    },
    receiptUrl: { type: String },
    notes: { type: String },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    // Scopes this expense to one tenant deployment (see hrms_branch_model.js's
    // identical field) — every controller reading/writing expenses must filter
    // by this so different tenants sharing this backend never see each other's
    // expense claims.
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  },
  { timestamps: true }
);

ExpenseSchema.index({ storeId: 1, date: -1 });
ExpenseSchema.index({ status: 1 });

// Registered under a name distinct from the main CRM's own "Expense" model
// (src/models/Expense.js). Both used to register as "Expense" — whichever
// loaded first in index.js won the shared Mongoose model registry, so this
// schema was silently never used and every save/read here actually ran
// against the main CRM's unrelated Expense schema (no storeId/status/etc.).
module.exports = (mongoose.models["HRMSExpense"] || mongoose.model("HRMSExpense", ExpenseSchema));
