const mongoose = require("mongoose");

const creditNoteSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
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
    // Form fields that used to be dropped on save.
    reference: { type: String, default: "" },
    project: { type: String, default: "" },
    admin_note: { type: String, default: "" },
    client_note: { type: String, default: "" },
    terms: { type: String, default: "" },
    date: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: Number,
      default: 1, // 1=open, 2=closed, 3=void
    },
    subtotal: {
      type: Number,
      required: true,
    },
    total: {
      type: Number,
      required: true,
    },
    items: [
      {
        description: String,
        long_description: String,
        qty: Number,
        rate: Number,
        tax: Number,
      },
    ],
    currency: {
      type: String,
      default: "USD",
    },
    invoices_credited: [
      {
        invoice: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Invoice",
        },
        invoice_number: String,
        amount: Number,
        date: {
          type: Date,
          default: Date.now,
        },
      }
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    branch: {
      type: String,
      default: "",
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

creditNoteSchema.virtual("remaining_amount").get(function () {
  const totalApplied = (this.invoices_credited || []).reduce((sum, inv) => sum + (inv.amount || 0), 0);
  return Math.max(this.total - totalApplied, 0);
});

creditNoteSchema.index(
  { tenant_id: 1, number: 1 },
  { unique: true, name: "tenant_id_1_number_1", partialFilterExpression: { number: { $type: "string" } } }
);

const CreditNote = mongoose.model("CreditNote", creditNoteSchema);

module.exports = CreditNote;
