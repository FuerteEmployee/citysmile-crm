const mongoose = require("mongoose");

// Gujarat GSTIN state code is "24" — a GSTIN's first two digits identify the state
const HOME_STATE = "Gujarat";

const purchaseSchema = new mongoose.Schema(
  {
    bill_no: {
      type: String,
      required: true,
      trim: true,
    },
    bill_date: {
      type: Date,
      default: Date.now,
    },
    voucher_type: {
      // "Voucher Type" column from Tally-style Purchase Register imports (e.g. "Purchase")
      type: String,
      trim: true,
      default: "",
    },
    branch: {
      // "Branch Name" column from Tally-style Purchase Register imports
      type: String,
      trim: true,
      default: "",
    },
    due_date: {
      type: Date,
      default: null,
    },
    vendor_id: {
      // Set only for tenants with vendor-linked purchases enabled (see
      // utils/featureFlags.js). supplier_* fields below are always a
      // snapshot taken at save time — they never change if the vendor
      // record is edited later, so historical bills stay accurate.
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
      index: true,
    },
    supplier_name: {
      // "Company Name" column on the bill
      type: String,
      required: true,
      trim: true,
    },
    supplier_address: {
      // "Address with State" column — free-text address
      type: String,
      trim: true,
      default: "",
    },
    supplier_state: {
      type: String,
      default: HOME_STATE,
      trim: true,
    },
    supplier_gstin: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    description: String,
    item_id: {
      // Optional — a purchase line can stay free-text with no linked item.
      // product/hsn_code/rate below are always a snapshot taken at save
      // time, so a later item-master rate/HSN change never touches old bills.
      type: mongoose.Schema.Types.ObjectId,
      ref: "Item",
      default: null,
      index: true,
    },
    product: {
      type: String,
      trim: true,
      default: "",
    },
    hsn_code: {
      // HSN/SAC code
      type: String,
      trim: true,
      default: "",
    },
    quantity: {
      type: Number,
      default: 1,
    },
    rate: {
      // Per-unit rate
      type: Number,
      default: 0,
    },
    amount: {
      // "Price" column = quantity × rate (taxable value before freight & tax)
      type: Number,
      required: true,
      default: 0,
    },
    freight_charge: {
      type: Number,
      default: 0,
    },
    gst_rate: {
      // Total GST percentage, e.g. 18
      type: Number,
      default: 0,
    },
    tax_type: {
      // GST  = intra-state (CGST + SGST), IGST = inter-state
      type: String,
      enum: ["GST", "IGST"],
      default: "GST",
    },
    cgst: {
      type: Number,
      default: 0,
    },
    sgst: {
      type: Number,
      default: 0,
    },
    igst: {
      type: Number,
      default: 0,
    },
    round_off: {
      // Difference between raw total and the rounded grand total
      type: Number,
      default: 0,
    },
    // Set only by the manual "New Purchase" form's multi-product mode — one
    // bill can hold several product lines, each taxed on its own price +
    // freight. When present, the flat fields above (product/quantity/rate/
    // amount/freight_charge/gst_rate/cgst/sgst/igst/total) are bill-level
    // rollups computed from these items, so anything that only reads the
    // flat fields (reports, vendor view, the purchase list) keeps working
    // unchanged. Left empty for single-line bills (manual quick-entry and
    // every Tally-register import row).
    items: [
      {
        item_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Item",
          default: null,
        },
        product: { type: String, trim: true, default: "" },
        hsn_code: { type: String, trim: true, default: "" },
        quantity: { type: Number, default: 1 },
        rate: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
        freight_charge: { type: Number, default: 0 },
        gst_rate: { type: Number, default: 0 },
        cgst: { type: Number, default: 0 },
        sgst: { type: Number, default: 0 },
        igst: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        // Procurement Types extensions (Kiran & manufacturing tenants)
        procurementType: {
          type: String,
          enum: ["READY", "JOBWORK", "MANUFACTURE", null],
          default: null,
        },
        categoryId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "PurchaseCategory",
          default: null,
        },
        subcategoryId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "PurchaseCategory",
          default: null,
        },
        locationId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "FactoryLocation",
          default: null,
        },
        jobWorkOrderId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "JobWorkOrder",
          default: null,
        },
        productionOrderId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ProductionOrder",
          default: null,
        },
      },
    ],
    // Bill-level procurement extensions
    procurementType: {
      type: String,
      enum: ["READY", "JOBWORK", "MANUFACTURE", null],
      default: null,
      index: true,
    },
    locationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FactoryLocation",
      default: null,
      index: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseCategory",
      default: null,
      index: true,
    },
    subcategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseCategory",
      default: null,
      index: true,
    },
    jobWorkOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobWorkOrder",
      default: null,
    },
    productionOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionOrder",
      default: null,
    },
    total: {
      // Grand total, rounded to the nearest rupee
      type: Number,
      default: 0,
    },
    payment_status: {
      type: String,
      enum: ["Unpaid", "Paid", "Partially Paid"],
      default: "Unpaid",
    },
    payment_date: {
      type: Date,
      default: null,
    },
    paymentmode: String,
    journal: {
      type: String,
      trim: true,
      default: "",
    },
    bank_details: {
      type: String,
      trim: true,
      default: "",
    },
    sales_person: {
      type: String,
      trim: true,
      default: "",
    },
    note: String,
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

const Purchase = mongoose.model("Purchase", purchaseSchema);

module.exports = Purchase;
