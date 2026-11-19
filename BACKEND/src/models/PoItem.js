const mongoose = require("mongoose");

// The Purchase Orders add-on's own item list ("PO Items" tab): code, name,
// HSN, unit, GST % and the price master. Separate from the CRM Items module
// (/admin/items) — nothing is read from or written to Item.js. Filled only by
// "Add item" or "Upload items (Excel)" inside the PO module.
//
// item_code (when set) and name are unique per company, case-insensitive.
// That is enforced in purchase_order_controller (with a lock), not by a
// unique index.

const price = { type: Number, default: 0, min: 0 };

const poItemSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    item_code: { type: String, trim: true, maxlength: 100 }, // Brady catalog no.
    y_code: { type: String, trim: true, default: "", maxlength: 50 }, // Brady Y code
    name: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: "", maxlength: 2000 },
    hsn: { type: String, trim: true, default: "", maxlength: 50 },
    unit: { type: String, trim: true, default: "Nos", maxlength: 30 },
    tax_rate: { type: Number, default: 0, min: 0, max: 100 }, // GST %
    master_price: price,
    cost_price: price, // landing cost
    distributor_price: price,
    end_customer_price: price,
    // From the Brady price list (R3): lead time, remarks, the sheet the item
    // came from (shown as "category") and any other columns (Material,
    // Color, Width…) kept as plain-text attributes.
    lead_time: { type: String, trim: true, default: "", maxlength: 100 },
    remarks: { type: String, trim: true, default: "", maxlength: 500 },
    category: { type: String, trim: true, default: "", maxlength: 100 },
    // Round 30: the sheet the PRICES came from (the duplicate-priority
    // winner, e.g. "New Replacement Part M611 M710") — can differ from the
    // series (category). Shown as "Price from sheet: …".
    price_sheet: { type: String, trim: true, default: "", maxlength: 100 },
    attributes: { type: Map, of: String, default: undefined },
    // "New Replacement Part" sheet: the obsolete catalog / Y numbers this item
    // replaces, and (on an obsolete item) the catalog that replaces it.
    replaces: { type: [String], default: undefined },
    replaced_by: { type: String, trim: true, maxlength: 100 },
    // Switched off = hidden from the PO editor's picker; POs that already
    // use it still open and print from their own saved copy.
    active: { type: Boolean, default: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

const PoItem = mongoose.model("PoItem", poItemSchema);

module.exports = PoItem;
