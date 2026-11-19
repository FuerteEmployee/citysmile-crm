const mongoose = require("mongoose");

const sopDocumentSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    title: { type: String, required: true },
    fileUrl: { type: String },
    version: { type: String, default: "1.0" },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["SOPDocument"] || mongoose.model("SOPDocument", sopDocumentSchema));
