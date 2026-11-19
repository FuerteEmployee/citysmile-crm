const mongoose = require("mongoose");

// Proforma Invoice (R5) — made for the CUSTOMER from an approved Purchase PO
// (Purchase Orders add-on). Same lines as the PO at the customer's selling
// price; layout of the client's proforma sheet (F3). The seller block, bank
// details and commercial terms are copied from PO Settings → "Company details
// for PO and proforma" (never from code). Linked to its PO both ways: `po`
// here, and the PO's GET lists its proformas.
//
// Numbers ("0197") run per financial year from an atomic counter in
// PoSettings (counters.proforma_<FY>); there is deliberately no unique index.

const lineSchema = new mongoose.Schema(
  {
    item_id: { type: mongoose.Schema.Types.ObjectId, ref: "PoItem" },
    ref_no: String, // catalog no. ("REF No.")
    description: String, // Y code / text ("DESCRIPTION")
    hsn: String,
    qty: { type: Number, default: 1, min: 0 },
    unit: String,
    rate: { type: Number, default: 0, min: 0 }, // selling price, whole rupees (Q3)
    disc_pct: { type: Number, default: 0, min: 0, max: 100 },
    gst_pct: { type: Number, default: 18, min: 0, max: 100 },
    taxable: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // Freight / packing typed on the proforma (not from the PO).
    is_extra: { type: Boolean, default: false },
  },
  { _id: true }
);

const partySchema = new mongoose.Schema(
  { name: String, address: String, gstin: String, state: String, email: String, phone: String, whatsapp: String },
  { _id: false }
);

const proformaSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    po: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    po_number: String,
    number: { type: String, required: true },
    fy: String,
    date: { type: Date, default: Date.now },
    valid_until: Date,
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    bill_to: partySchema,
    customer_po_number: String,
    customer_po_date: Date,
    tax_type: { type: String, enum: ["igst", "cgst_sgst"], default: "igst" },
    lines: [lineSchema],
    totals: {
      taxable: { type: Number, default: 0 },
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      grand_total: { type: Number, default: 0 },
      advance: { type: Number, default: 0 },
      balance: { type: Number, default: 0 },
    },
    amount_in_words: String,
    // The company's own details at the time (seller block, bank, terms).
    seller: { type: mongoose.Schema.Types.Mixed },
    notes: String,
    // draft (editable) → sent (locked once sent on WhatsApp); cancelled.
    status: { type: String, enum: ["draft", "sent", "cancelled"], default: "draft" },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    history: [
      {
        action: String, // created, edited, whatsapp, cancelled
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        at: { type: Date, default: Date.now },
        note: String,
        _id: false,
      },
    ],
    whatsapp_log: [
      {
        to: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        method: { type: String, enum: ["document", "template"] },
        status: { type: String, enum: ["sent", "simulated", "failed"] },
        message_id: String,
        error: String,
        _id: false,
      },
    ],
  },
  { timestamps: true, optimisticConcurrency: true }
);

const ProformaInvoice = mongoose.model("ProformaInvoice", proformaSchema);

module.exports = ProformaInvoice;
