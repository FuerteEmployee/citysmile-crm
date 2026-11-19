const mongoose = require("mongoose");

// One per company using the "purchase_orders" add-on. Everything the business
// may want to change later (divisions and their number series, the pricing
// rules, the supplier block, the PDF layout, the WhatsApp template) lives
// here instead of in code. Defaults come from DEFAULT_PO_SETTINGS on first read.

const PRICE_FIELDS = ["master_price", "distributor_price", "end_customer_price"];

// One schema per PO type. Purchase POs always use the floor now (R6 — the
// controller forces it on whatever is saved); old Sales POs keep theirs. A
// saved settings document without price_floor gets this default when read.
const ruleSchemaFor = (priceFloorDefault) =>
  new mongoose.Schema(
    {
      // Which item price a line's selling price is compared against.
      list_price_field: { type: String, enum: PRICE_FIELDS, default: "end_customer_price" },
      // null = that check is off.
      max_discount_pct: { type: Number, default: null, min: 0, max: 100 },
      min_margin_pct: { type: Number, default: null, min: 0, max: 100 },
      // Ignored while price_floor is on (below list is then refused outright).
      allow_below_list: { type: Boolean, default: true },
      // "Price only up": a selling price below the list price is refused, and
      // any raise above it needs an approver.
      price_floor: { type: Boolean, default: priceFloorDefault },
    },
    { _id: false }
  );

const poSettingsSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, unique: true },
    // Separate businesses that keep their POs and numbering apart (e.g. Brady
    // and Sparkling). `key` is stored on each PO and never changes.
    divisions: [
      {
        key: { type: String, required: true, match: /^[a-z0-9_-]+$/ },
        name: { type: String, required: true, trim: true },
        // PO number "<purchase_prefix>/<nn>/<FY>", e.g. DA/07/26-27 (R2).
        purchase_prefix: { type: String, required: true, trim: true },
        // Old Sales PO series (Sales PO was removed — kept for old records).
        sales_prefix: { type: String, trim: true, default: "" },
        active: { type: Boolean, default: true },
        _id: false,
      },
    ],
    // Next-number counters, bumped atomically: "<division>_purchase_<FY>" for
    // PO numbers (restart every April), "proforma_<FY>" for proformas. Old
    // keys "<division>_<type>_<year>" stay for old records.
    counters: { type: Map, of: Number, default: {} },
    rules: {
      purchase: { type: ruleSchemaFor(true), default: () => ({}) },
      sales: { type: ruleSchemaFor(true), default: () => ({}) },
    },
    // Snapshotted onto every PO when it is created.
    supplier: {
      name: { type: String, default: "Brady" },
      address: { type: String, default: "" },
      gstin: { type: String, default: "" },
      state: { type: String, default: "" },
      phone: { type: String, default: "" },
      whatsapp: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    // Q4: the company's OWN details — buyer block of the PO, seller block,
    // bank details and commercial terms of the proforma. Nothing
    // company-specific is in code. Shown prefilled from the CRM company
    // profile (Setup > Settings) until an admin saves them (saved_at set).
    company: {
      name: { type: String, default: "" },
      line2: { type: String, default: "" },
      address: { type: String, default: "" },
      gstin: { type: String, default: "" },
      state: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      logo_url: { type: String, default: "" },
      bank_account_name: { type: String, default: "" },
      bank_name_branch: { type: String, default: "" },
      bank_account_no: { type: String, default: "" },
      bank_ifsc: { type: String, default: "" },
      po_terms: { type: String, default: "" }, // terms box on the PO
      payment_terms: { type: String, default: "" }, // proforma commercial terms
      delivery_terms: { type: String, default: "" },
      saved_at: Date,
    },
    // Proforma invoices (R5): number "<prefix>0001", running per FY, and the
    // default "valid until" (days after the proforma date).
    proforma: {
      prefix: { type: String, default: "" },
      // min stays 0 so an older saved 0 still loads / saves; new values are
      // checked 1-365 by the controller (round 29, S4).
      valid_days: { type: Number, default: 15, min: 0, max: 365 },
    },
    // Round 29 (S1): the price-list series (sheet, e.g. "M210") the PO Items
    // tab and the PO editor's item picker open on. "" = All series; a series
    // with no items also falls back to All series.
    default_series: { type: String, trim: true, default: "M210", maxlength: 40 },
    // Round 30 (S6): the current reference price list (PoPriceListEntry rows
    // with this upload_id). Set only by POST /items/pricelist/reference.
    price_list_ref: {
      upload_id: { type: String, default: "" },
      count: { type: Number, default: 0 },
      file_name: { type: String, default: "", maxlength: 200 },
      uploaded_at: Date,
      uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    },
    // Q2: per customer (Client id) the price that is the selling-price
    // floor: "end_user" (also when not listed) or "distributor".
    customer_price_levels: { type: Map, of: String, default: {} },
    // R3: column mappings the user confirmed, one per header signature, so
    // the next upload of the same price list skips the mapping step.
    import_mappings: [
      {
        signature: String,
        sheet_name: String,
        fields: { type: mongoose.Schema.Types.Mixed }, // { "<column index>": "<field>" }
        saved_at: { type: Date, default: Date.now },
        saved_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        _id: false,
      },
    ],
    // Used when the recipient hasn't messaged in the last 24 hours. The
    // template needs a DOCUMENT header; body_params fill its {{1}}, {{2}}…
    // and may use the same placeholders as the PDF format.
    whatsapp: {
      template_name: { type: String, default: "" },
      template_language: { type: String, default: "en" },
      body_params: { type: [String], default: [] },
    },
    // PDF layout (see DEFAULT_FORMAT). Every change gets a new version; each
    // PO keeps the version it was created with so it reprints unchanged.
    format: { type: mongoose.Schema.Types.Mixed },
    format_version: { type: Number, default: 1 },
    format_history: [
      {
        version: Number,
        format: mongoose.Schema.Types.Mixed,
        saved_at: { type: Date, default: Date.now },
        saved_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

const DEFAULT_FORMAT = {
  title_purchase: "Purchase Order",
  title_sales: "Sales Order",
  header: { company_name: "", address: "", gstin: "", phone: "", email: "", show_logo: true },
  branding_line: "Exclusive All-India Partner for Brady",
  show_supplier_block: true,
  columns: [
    { key: "sr", label: "#", visible: true },
    { key: "item_code", label: "Item Code", visible: true },
    { key: "name", label: "Description", visible: true },
    { key: "hsn", label: "HSN", visible: true },
    { key: "qty", label: "Qty", visible: true },
    { key: "unit", label: "Unit", visible: false },
    { key: "rate", label: "Rate", visible: true },
    { key: "discount", label: "Disc %", visible: false },
    { key: "tax", label: "GST %", visible: true },
    { key: "amount", label: "Amount", visible: true },
  ],
  footer: {
    terms: "",
    payment_terms: "",
    delivery_terms: "",
    bank_details: "",
    signature_label: "Authorised Signatory",
  },
};

const DEFAULT_PO_SETTINGS = {
  divisions: [
    // Only Brady by default; an admin adds more divisions in PO Settings.
    { key: "brady", name: "Brady", purchase_prefix: "PPO", sales_prefix: "SPO", active: true },
  ],
  rules: {
    // Purchase PO (Brady flow): selling price only up from the End User Price
    // (R6, always on); a margin under 13% is pointed out to the approver.
    purchase: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: 13, allow_below_list: false, price_floor: true },
    // Sales PO: price only up — below the list price is refused, at list is
    // free, any raise above list needs an approver.
    sales: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false, price_floor: true },
  },
  format: DEFAULT_FORMAT,
  format_version: 1,
};

const PoSettings = mongoose.model("PoSettings", poSettingsSchema);

module.exports = PoSettings;
module.exports.DEFAULT_FORMAT = DEFAULT_FORMAT;
module.exports.DEFAULT_PO_SETTINGS = DEFAULT_PO_SETTINGS;
module.exports.PRICE_FIELDS = PRICE_FIELDS;
