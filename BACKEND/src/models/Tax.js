const mongoose = require("mongoose");

const taxSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    taxrate: {
      type: Number,
      required: true,
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

taxSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const Tax = mongoose.model("Tax", taxSchema);

module.exports = Tax;
