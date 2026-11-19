const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema(
  {
    company_name: {
      type: String,
      required: true,
      trim: true,
    },
    vendor_reference: {
      type: String,
      trim: true,
      default: "",
    },
    connect_person: {
      type: String,
      trim: true,
      default: "",
    },
    phone_number: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      // "Address with State" column — free-text address
      type: String,
      trim: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    pan_number: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    gst_number: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    account_details: {
      type: String,
      trim: true,
      default: "",
    },
    sales_person: {
      type: String,
      trim: true,
      default: "",
    },
    branch: {
      type: String,
      trim: true,
      default: "",
    },
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

// Enforce unique company name per tenant at the database level
vendorSchema.index({ tenant_id: 1, company_name: 1 }, { unique: true });

const Vendor = mongoose.model("Vendor", vendorSchema);

module.exports = Vendor;
