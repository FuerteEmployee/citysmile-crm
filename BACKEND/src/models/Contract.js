const mongoose = require("mongoose");

const contractSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    contract_value: {
      type: Number,
      default: 0,
    },
    contract_type: String,
    datestart: Date,
    dateend: Date,
    description: String,
    content: String, // HTML content
    is_signed: {
      type: Boolean,
      default: false,
    },
    signer_firstname: String,
    signer_lastname: String,
    signer_email: String,
    signature_data: String, // base64 PNG data URL captured from the signature pad
    signed_at: Date,
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

const Contract = mongoose.model("Contract", contractSchema);

module.exports = Contract;
