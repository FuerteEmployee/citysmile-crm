const mongoose = require("mongoose");

const paymentModeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    show_on_pdf: {
      type: Boolean,
      default: false,
    },
    selected_by_default: {
      type: Boolean,
      default: false,
    },
    invoices_only: {
      type: Boolean,
      default: false,
    },
    expenses_only: {
      type: Boolean,
      default: false,
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

paymentModeSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const PaymentMode = mongoose.model("PaymentMode", paymentModeSchema);

module.exports = PaymentMode;
