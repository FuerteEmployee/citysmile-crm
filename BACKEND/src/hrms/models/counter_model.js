const mongoose = require("mongoose");

// Each document tracks the last-used sequence number for one (voucherType, branchId, fiscalYear) combination.
// findOneAndUpdate with $inc is atomic in MongoDB — eliminates the race condition in getNextDocNo.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // key: "RV|branchId|2526"
  seq: { type: Number, default: 0 },
});

module.exports = (mongoose.models["Counter"] || mongoose.model("Counter", counterSchema));
