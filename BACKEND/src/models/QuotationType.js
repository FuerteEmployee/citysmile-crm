const mongoose = require("mongoose");

// A dynamically admin-defined "Quotation Type" (e.g. Electrical, Interior,
// Home Automation). Each one gets its own entry in the "Quotation Maker"
// sidebar group and carries a default PDF theme + allowed create-format(s).
const quotationTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    icon: {
      type: String,
      default: "FileBarChart",
    },
    format: {
      type: String,
      enum: ["simple", "pro", "both"],
      default: "both",
    },
    theme: {
      primaryColor: { type: String, default: "#3592ea" },
      roomHeaderBg: { type: String, default: "#882200" },
      headerText: { type: String, default: "#ffffff" },
      topBorder: { type: String, default: "#3592ea" },
      flatTypeBg: { type: String, default: "#1f2937" },
      flatTypeText: { type: String, default: "#ffffff" },
    },
    order: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  { timestamps: true }
);

quotationTypeSchema.index({ tenant_id: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model("QuotationType", quotationTypeSchema);
