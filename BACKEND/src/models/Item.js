const mongoose = require("mongoose");
require("./PurchaseCategory");

const itemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    long_description: {
      type: String,
      trim: true,
    },
    quantity: {
      type: Number,
      default: 1,
      min: [0, "Quantity cannot be negative"],
    },
    rate: {
      type: Number,
      default: 0,
      min: [0, "Rate cannot be negative"],
    },
    amount: {
      type: Number,
      default: 0,
      min: [0, "Amount cannot be negative"],
    },
    tax: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tax",
    },
    tax2: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tax",
    },
    hsn_sac_code: {
      type: String,
      trim: true,
    },
    cess_rate: {
      type: Number,
      default: 0,
      min: [0, "Cess rate cannot be negative"],
      max: [100, "Cess rate cannot be more than 100"],
    },
    tax_inclusive: {
      type: Boolean,
      default: false,
    },
    unit: {
      type: String,
    },
    group: {
      type: String, // String category for simple grouping
    },
    branch: {
      type: String,
      default: "",
    },
    // Old price master of the "purchase_orders" add-on. No longer used: the PO
    // module has its own item list (PoItem.js). Kept in place (item_controller
    // still strips them from the Items form); not read or written by POs.
    item_code: { type: String, trim: true },
    master_price: { type: Number, default: 0 },
    cost_price: { type: Number, default: 0 }, // landing cost
    distributor_price: { type: Number, default: 0 },
    end_customer_price: { type: Number, default: 0 },
    // Procurement Types extensions (Kiran & manufacturing tenants)
    procurementType: {
      type: String,
      enum: ["READY", "JOBWORK", "MANUFACTURE", null],
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
    uom: {
      type: String,
      trim: true,
      default: "",
    },
    hsn: {
      type: String,
      trim: true,
      default: "",
    },
    gstRate: {
      type: Number,
      enum: [0, 5, 12, 18, 28, null],
      default: null,
    },
    spec: {
      type: String,
      trim: true,
      default: "",
    },
    preferredVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
    },
    reorderLevel: {
      type: Number,
      default: 0,
    },
    isAssembly: {
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

const Item = mongoose.model("Item", itemSchema);

module.exports = Item;
