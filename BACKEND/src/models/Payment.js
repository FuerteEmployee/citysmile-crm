const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    invoice: {
      // Optional — voucher-style payments (Company Name/Voucher Number/Journal)
      // aren't necessarily tied to an Invoice document.
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },
    client: {
      // Optional — lets a standalone (non-invoice) payment be tied to a real
      // Client record, e.g. so its branch can be looked up/displayed.
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    branch: {
      type: String,
      trim: true,
      default: "",
    },
    amount: {
      type: Number,
      required: true,
    },
    paymentmode: {
      type: String, // e.g. "bank", "check", "paypal"
    },
    paymentmethod: {
      type: String,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    transactionid: {
      type: String,
    },
    companyName: {
      type: String,
      trim: true,
      default: "",
    },
    voucherNumber: {
      type: String,
      trim: true,
      default: "",
    },
    billDate: {
      type: Date,
      default: null,
    },
    journal: {
      type: String,
      trim: true,
      default: "",
    },
    note: {
      type: String,
    },
    // Set when the payment came from applying a credit note, so deleting the
    // payment can give the credit back.
    credit_note: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CreditNote",
      default: null,
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

const Payment = mongoose.model("Payment", paymentSchema);

module.exports = Payment;
