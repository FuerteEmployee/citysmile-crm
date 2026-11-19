const mongoose = require("mongoose");

const contractTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
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

const ContractType = mongoose.model("ContractType", contractTypeSchema);

module.exports = ContractType;
