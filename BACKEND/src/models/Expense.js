const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
    category: {
      type: String, // Or ref to ExpenseCategory
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    tax: {
      type: Number,
      default: 0,
    },
    tax2: {
      type: Number,
      default: 0,
    },
    reference_no: String,
    note: String,
    expense_name: String,
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    billable: {
      type: Boolean,
      default: false,
    },
    invoiceid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
    paymentmode: String,
    date: {
      type: Date,
      default: Date.now,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Expense = mongoose.model("Expense", expenseSchema);

module.exports = Expense;
