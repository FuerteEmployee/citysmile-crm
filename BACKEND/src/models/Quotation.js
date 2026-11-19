const mongoose = require("mongoose");

const quotationSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    number: {
      type: String,
      required: true,
      unique: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    valid_till: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["draft", "sent", "pending", "accepted", "rejected", "expired"],
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
    currency: {
      type: String,
      default: "INR",
    },
    items: [
      {
        description: String,
        long_description: String,
        qty: { type: Number, default: 1 },
        rate: { type: Number, default: 0 },
        tax: { type: Number, default: 0 }, // Tax percentage
        tax_name: String,
        photo_url: String,
      },
    ],
    notes: String,
    adminnote: String,
    total_tax: {
      type: Number,
      default: 0,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },

    // --- Quotation Maker (dynamic types) fields below ---
    // Which admin-defined type this quotation was created under (Electrical,
    // Interior, etc). Optional so pre-existing quotations keep working.
    quotation_type: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuotationType",
    },
    format: {
      type: String,
      enum: ["simple", "pro"],
      default: "simple",
    },
    gst_percent: {
      type: Number,
      default: 18,
    },
    contact_number: String,
    client_address: String,
    branding: {
      brandLogoUrl: String,
      clientLogoUrl: String,
      brandName: String,
      fullCompanyName: String,
      tagline: String,
      contactAddress: String,
      defaultContactNumber: String,
    },
    project_details: {
      project_building: String,
      unit_no: String,
      flat_type: String,
    },
    // Pro-format grouped items ("Rooms & Items"). Simple format keeps using
    // the flat `items` array above.
    rooms: [
      {
        name: { type: String, required: true },
        items: [
          {
            description: String,
            series: String,
            model_no: String,
            unit_price: { type: Number, default: 0 },
            sw: { type: Number, default: 0 },
            fan: { type: Number, default: 0 },
            soc: { type: Number, default: 0 },
            mod: { type: Number, default: 0 },
            qty: { type: Number, default: 1 },
            disc_percent: { type: Number, default: 0 },
            photo_url: String,
          },
        ],
      },
    ],
    theme: {
      primaryColor: String,
      roomHeaderBg: String,
      headerText: String,
      topBorder: String,
      flatTypeBg: String,
      flatTypeText: String,
    },
    // "Include item photos in quotation output & PDF" toggle.
    show_item_images: { type: Boolean, default: true },
    attachments: {
      before_images: [String],
      after_images: [String],
    },
    bank_detail: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankDetail",
    },
    // Internal sign-off, only used when the tenant has the "quotation_approval"
    // add-on. Separate from `status`, which tracks the client's response.
    // No default on purpose: quotations created before the add-on was turned
    // on have no `approval` and stay usable as before.
    approval: {
      status: { type: String, enum: ["none", "pending", "approved", "rejected"] },
      requested_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      requested_at: Date,
      decided_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      decided_at: Date,
      comment: String,
    },
    // Every approval step, oldest first — shown as the quotation's approval history.
    approval_history: [
      {
        action: { type: String, enum: ["requested", "approved", "rejected", "auto_approved", "reset"] },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        at: { type: Date, default: Date.now },
        comment: String,
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
  }
);

const Quotation = mongoose.model("Quotation", quotationSchema);

module.exports = Quotation;
