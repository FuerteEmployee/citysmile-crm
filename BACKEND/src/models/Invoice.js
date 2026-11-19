const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    // Unique per company (index below), not across all companies.
    number: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    duedate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["unpaid", "paid", "partially_paid", "overdue", "cancelled", "draft", "sent", "sent_later", "recorded"],
      default: "unpaid",
    },
    subtotal: {
      type: Number,
      required: true,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
      default: 0,
    },
    discount_percent: {
      type: Number,
      default: 0,
    },
    // "percent" uses discount_percent, "fixed" uses discount_fixed (money),
    // "no_discount" means none. Empty (older invoices) = percent.
    discount_type: {
      type: String,
      enum: ["", "percent", "fixed", "no_discount"],
      default: "",
    },
    discount_fixed: {
      type: Number,
      default: 0,
    },
    discount_total: {
      type: Number,
      default: 0,
    },
    adjustment: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
    voucherType: {
      type: String,
      trim: true,
      default: "",
    },
    // Title printed by the letterhead PDF formats: "invoice" or "proforma".
    // Empty means "use the format chosen in Settings > Invoice PDF Format".
    document_type: {
      type: String,
      enum: ["", "invoice", "proforma"],
      default: "",
    },
    partyAddress: {
      type: String,
      trim: true,
      default: "",
    },
    partyGroup: {
      type: String,
      trim: true,
      default: "",
    },
    termsOfPayment: {
      type: String,
      trim: true,
      default: "",
    },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    // Buyer's VAT number, filled from the customer (Client.vat) on the form.
    vat: {
      type: String,
      trim: true,
      default: "",
    },
    items: [
      {
        description: String,
        long_description: String,
        qty: { type: Number, default: 1 },
        rate: { type: Number, default: 0 },
        tax: { type: Number, default: 0 }, // Tax percentage
        tax_name: String,
        itemGroup: { type: String, trim: true, default: "" },
        itemHSN: { type: String, trim: true, default: "" },
        itemBatch: { type: String, trim: true, default: "" },
        unit: { type: String, trim: true, default: "" },
        gstPercentage: { type: Number, default: 0 },
        // Added to (qty * rate) before GST — matches the Purchase module's
        // per-line freight, so freight itself is part of the taxable value.
        freight_charge: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    ],
    notes: String,
    // Terms & Conditions printed on the invoice (prefilled from Setup > Settings > Invoices).
    terms: { type: String, default: "" },
    adminnote: String,
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    tags: [String],
    total_tax: {
      type: Number,
      default: 0,
    },
    tax_type: {
      type: String,
      enum: ["GST", "IGST"],
      default: "GST",
    },
    total_cgst: {
      type: Number,
      default: 0,
    },
    total_sgst: {
      type: Number,
      default: 0,
    },
    total_igst: {
      type: Number,
      default: 0,
    },
    total_freight: {
      type: Number,
      default: 0,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    // Every "Send Invoice to Email" that went out (shown on the Emails Tracking tab).
    email_log: [
      {
        _id: false,
        to: [String],
        cc: [String],
        subject: String,
        pdf_attached: Boolean,
        sent_at: Date,
        sent_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      },
    ],
    salesPerson: {
      type: String,
      default: "",
    },
    branch: {
      type: String,
      default: "",
    },
    bank_detail: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankDetail",
    },
  },
  {
    timestamps: true,
  }
);

invoiceSchema.index({ tenant_id: 1, number: 1 }, { unique: true, name: "tenant_id_1_number_1" });

const Invoice = mongoose.model("Invoice", invoiceSchema);

module.exports = Invoice;
