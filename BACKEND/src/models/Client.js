const mongoose = require("mongoose");
const { toE164 } = require("../utils/phoneNormalize");

const clientSchema = new mongoose.Schema(
  {
    company: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    vat: {
      type: String,
      trim: true,
    },
    phonenumber: {
      type: String,
      trim: true,
    },
    // Normalized E.164 shadow of `phonenumber`, kept in sync by the pre-save
    // hook below. Nothing before this ever normalized phone numbers on the
    // way in, so `phonenumber` itself is a mix of formats — this field is
    // what the Calling Agent's caller-ID lookup matches against.
    phoneE164: {
      type: String,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    website: {
      type: String,
      trim: true,
    },
    customer_reference: {
      type: String,
      trim: true,
    },
    contact_person: {
      type: String,
      trim: true,
    },
    pan_number: {
      type: String,
      trim: true,
    },
    gst_number: {
      type: String,
      trim: true,
    },
    account_details: {
      type: String,
      trim: true,
    },
    sales_person: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    currency: String,
    default_language: String,
    address: String,
    city: String,
    state: String,
    zip: String,
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSBranch",
      default: null,
    },
    country: {
      type: String,
      trim: true,
    },
    billing_street: String,
    billing_city: String,
    billing_state: String,
    billing_zip: String,
    billing_country: String,
    shipping_street: String,
    shipping_city: String,
    shipping_state: String,
    shipping_zip: String,
    shipping_country: String,
    groups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ClientGroup",
      },
    ],
    active: {
      type: Boolean,
      default: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    datecreated: {
      type: Date,
      default: Date.now,
    },
    admins: [
      {
        staff: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Staff",
        },
        date_assigned: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    latitude: String,
    longitude: String,
  },
  {
    timestamps: true,
  }
);

clientSchema.pre("save", function (next) {
  if (this.isModified("phonenumber")) {
    this.phoneE164 = toE164(this.phonenumber) || undefined;
  }
  next();
});

// Enforce unique company name per tenant at the database level
clientSchema.index({ tenant_id: 1, company: 1 }, { unique: true });

const Client = mongoose.model("Client", clientSchema);

module.exports = Client;
