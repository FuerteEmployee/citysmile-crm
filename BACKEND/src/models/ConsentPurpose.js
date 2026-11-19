const mongoose = require("mongoose");

// A "purpose of consent" under Setup > GDPR > Consent — e.g. "Marketing
// Emails", "Newsletter" — that contacts/leads can be asked to consent to.
const consentPurposeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
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

module.exports = mongoose.model("ConsentPurpose", consentPurposeSchema);
