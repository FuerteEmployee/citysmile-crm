const mongoose = require("mongoose");

const estimateSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    connectPerson: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    mailId: {
      type: String,
      trim: true,
      default: "",
    },
    salesPerson: {
      type: String,
      trim: true,
      default: "",
    },
    // Buyer details filled from the customer on the form (they used to be
    // dropped on save because these fields didn't exist).
    billing_street: { type: String, trim: true, default: "" },
    billing_city: { type: String, trim: true, default: "" },
    billing_state: { type: String, trim: true, default: "" },
    billing_zip: { type: String, trim: true, default: "" },
    billing_country: { type: String, trim: true, default: "" },
    shipping_street: { type: String, trim: true, default: "" },
    shipping_city: { type: String, trim: true, default: "" },
    shipping_state: { type: String, trim: true, default: "" },
    shipping_zip: { type: String, trim: true, default: "" },
    shipping_country: { type: String, trim: true, default: "" },
    gstin: { type: String, trim: true, uppercase: true, default: "" },
    vat: { type: String, trim: true, default: "" },
    // Unique per company (index below), not across all companies.
    number: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    expirydate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["draft", "sent", "declined", "accepted", "expired"],
      default: "draft",
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
    discount_total: {
      type: Number,
      default: 0,
    },
    total_tax: {
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
    items: [
      {
        description: String,
        long_description: String,
        qty: { type: Number, default: 1 },
        rate: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
        tax: { type: Number, default: 0 },
        tax_name: String,
        // Same line fields as Invoice, so an item's unit / HSN survive on an
        // estimate and carry through when it's converted to an invoice.
        itemHSN: { type: String, trim: true, default: "" },
        unit: { type: String, trim: true, default: "" },
      },
    ],
    notes: String,
    adminnote: String,
    // Form fields that used to be dropped on save. Strings so an empty ""
    // from the form never fails to cast.
    terms: { type: String, default: "" },
    reference: { type: String, default: "" },
    project: { type: String, default: "" },
    sale_agent: { type: String, default: "" },
    tags: [String],
    invoice_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
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

estimateSchema.index(
  { tenant_id: 1, number: 1 },
  { unique: true, name: "tenant_id_1_number_1", partialFilterExpression: { number: { $type: "string" } } }
);

const Estimate = mongoose.model("Estimate", estimateSchema);

module.exports = Estimate;