const mongoose = require("mongoose");

// Round 30 (S6): the WHOLE uploaded Brady price list of a company, kept as a
// reference — every readable sheet, after the duplicate priority. Only the
// ticked sheets become PO Items; "+ Add Catalog No." and the PO editor's
// picker copy single catalogs from here into PO Items.
//
// Replaced as a whole on each upload: the entries of one upload share an
// upload_id; PoSettings.price_list_ref.upload_id points at the current one
// (switched only when the last batch arrived), older entries are deleted then.
// Never shown as PO items and never used on a PO directly.
const price = { type: Number, default: 0, min: 0 };

const schema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    upload_id: { type: String, required: true, maxlength: 64 },
    item_code: { type: String, trim: true, maxlength: 100 },
    y_code: { type: String, trim: true, default: "", maxlength: 50 },
    description: { type: String, default: "", maxlength: 2000 },
    unit: { type: String, trim: true, default: "", maxlength: 30 },
    hsn: { type: String, trim: true, default: "", maxlength: 50 },
    tax_rate: { type: Number, min: 0, max: 100 },
    master_price: price,
    distributor_price: price,
    end_customer_price: price,
    lead_time: { type: String, trim: true, default: "", maxlength: 100 },
    remarks: { type: String, trim: true, default: "", maxlength: 500 },
    category: { type: String, trim: true, default: "", maxlength: 100 }, // series (its sheet)
    price_sheet: { type: String, trim: true, default: "", maxlength: 100 }, // sheet the price came from
    attributes: { type: Map, of: String, default: undefined },
    replaces: { type: [String], default: undefined },
    // lower-case lookup keys (catalog, Y code, obsolete catalogs / Y codes)
    code_lc: { type: String, default: "" },
    y_lc: { type: String, default: "" },
    replaces_lc: { type: [String], default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ tenant_id: 1, upload_id: 1, code_lc: 1 });
schema.index({ tenant_id: 1, upload_id: 1, y_lc: 1 });
schema.index({ tenant_id: 1, upload_id: 1, replaces_lc: 1 });

module.exports = mongoose.model("PoPriceListEntry", schema);
