const mongoose = require("mongoose");

// Purchase Orders add-on ("purchase_orders"). Only Purchase POs to the
// supplier (Brady) are made now (R1):
//   purchase — Trinetra buys from Brady for a customer's order; the PDF shows
//              the cost (Master Distributor Price); the editor also shows the
//              customer's selling price and the margin (screen only).
//   sales    — OLD records only (Sales PO was removed); they open read-only.
// Every line carries both prices so margin is known.

const STATUSES = ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "cancelled"];

const lineSchema = new mongoose.Schema(
  {
    // A PoItem (the PO module's own item list). Lines made before PO Items
    // existed point at a CRM Item; they keep their saved copy below.
    item_id: { type: mongoose.Schema.Types.ObjectId, ref: "PoItem" },
    item_code: String, // Brady catalog no. ("Item of Requisition" on the PDF)
    y_code: String, // Brady Y code ("Description / Specification" on the PDF)
    name: { type: String, required: true },
    description: String,
    hsn: String,
    unit: String,
    qty: { type: Number, default: 1, min: 0 },
    qty_received: { type: Number, default: 0, min: 0 },
    cost_price: { type: Number, default: 0 }, // from the price master, never typed
    // Q1: where the cost came from — mdp (Master Distributor Price), dp (no
    // MDP on the price list: Distributor Price), landing (old cost price).
    cost_source: String,
    list_price: { type: Number, default: 0 }, // the rule's list price, from the price master
    selling_price: { type: Number, default: 0 },
    rate: { type: Number, default: 0 }, // printed rate: cost (purchase) or selling (sales)
    discount_pct: { type: Number, default: 0 }, // selling vs list
    margin_pct: { type: Number, default: null }, // selling vs cost; null when cost unknown
    margin_amount: { type: Number, default: null }, // ₹ (selling − cost) × qty — screen only
    tax_rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }, // qty × rate, before tax
    tax_amount: { type: Number, default: 0 },
    breaches: [String], // why this line needs approval
  },
  { _id: true }
);

const partySchema = new mongoose.Schema(
  {
    name: String,
    address: String,
    gstin: String,
    state: String,
    phone: String,
    whatsapp: String,
    email: String,
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    type: { type: String, enum: ["purchase", "sales"], required: true },
    division: { type: String, required: true },
    po_number: { type: String, required: true },
    po_date: { type: Date, default: Date.now },
    expected_date: Date,
    supplier: partySchema,
    // The customer (end user) this order is for. Optional (stock order).
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    customer_snapshot: partySchema,
    // Q2: which price is the floor for this customer — end_user (End User
    // Price, the default) or distributor (Distributor Price).
    price_level: { type: String, enum: ["end_user", "distributor"], default: "end_user" },
    // The company's own details for the buyer block (PO Settings → "Company
    // details for PO and proforma"), copied while the PO is a draft.
    buyer: { type: mongoose.Schema.Types.Mixed },
    // Financial year of the PO number ("26-27").
    fy: String,
    // The customer's own purchase order this PO was made from.
    customer_po_number: { type: String, trim: true, maxlength: 60 },
    customer_po_date: Date,
    // Optional copy of the customer's PO (PDF / JPG / PNG, up to 10 MB).
    customer_po_file: {
      type: new mongoose.Schema(
        {
          url: String,
          name: String, // the uploaded file's name, shown as plain text
          size: Number,
          mime: String,
          uploaded_at: Date,
          uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Old records only ("Create Brady PO" was removed with Sales PO): the
    // Purchase PO made from a Sales PO, and the Sales PO it came from.
    linked_purchase_po: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    source_sales_po: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    tax_mode: { type: String, enum: ["intra", "inter"], default: "intra" }, // CGST+SGST or IGST
    items: [lineSchema],
    totals: {
      subtotal: { type: Number, default: 0 },
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      tax_total: { type: Number, default: 0 },
      grand_total: { type: Number, default: 0 },
      sell_value: { type: Number, default: 0 },
      cost_value: { type: Number, default: 0 },
      margin_pct: { type: Number, default: null },
      margin_amount: { type: Number, default: null },
    },
    status: { type: String, enum: STATUSES, default: "draft", index: true },
    approval: {
      required: { type: Boolean, default: false },
      reasons: [String],
      requested_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      requested_at: Date,
      decided_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      decided_at: Date,
      decision: { type: String, enum: ["approved", "rejected", "auto_approved", null] },
      reason: String,
    },
    // The rule values the last check used, so a later settings change
    // doesn't rewrite why an old PO was or wasn't sent for approval.
    rule_snapshot: mongoose.Schema.Types.Mixed,
    notes: String,
    format_version: { type: Number, default: 1 },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    history: [
      {
        action: String, // created, edited, submitted, approved, rejected, auto_approved, status:<x>, whatsapp
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
  // Two people acting on one PO at once (Yes + No together): the second save
  // gets a VersionError instead of silently overwriting the first.
  { timestamps: true, optimisticConcurrency: true }
);

purchaseOrderSchema.index({ tenant_id: 1, po_number: 1 }, { unique: true });

const PurchaseOrder = mongoose.model("PurchaseOrder", purchaseOrderSchema);

module.exports = PurchaseOrder;
module.exports.PO_STATUSES = STATUSES;
