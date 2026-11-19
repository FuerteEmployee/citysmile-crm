const mongoose = require("mongoose");

const employeeDocumentSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: {
    type: String,
    enum: ["aadhaar", "pan", "resume", "offer_letter", "contract", "photo", "certificate", "bank_proof", "other"],
    required: true
  },
  fileUrl: { type: String, required: true },
  originalFileName: String,
  mimeType: String,
  verified: { type: Boolean, default: false },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  verifiedAt: Date,
  expiryDate: Date,
  notes: String
}, { timestamps: true });

module.exports = (mongoose.models["EmployeeDocument"] || mongoose.model("EmployeeDocument", employeeDocumentSchema));
