const mongoose = require("mongoose");

const currencySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    symbol: {
      type: String,
      required: true,
      trim: true,
    },
    decimal_separator: {
      type: String,
      default: ".",
    },
    thousand_separator: {
      type: String,
      default: ",",
    },
    placement: {
      type: String,
      enum: ["before", "after"],
      default: "before",
    },
    isdefault: {
      type: Boolean,
      default: false,
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

// Unique per tenant: same currency code can exist across different tenants
currencySchema.index({ name: 1, tenant_id: 1 }, { unique: true });

const Currency = mongoose.model("Currency", currencySchema);

// Drop the old global name_1 index if it exists so the new compound index takes over
Currency.collection.getIndexes().then((indexes) => {
  if (indexes["name_1"]) {
    Currency.collection.dropIndex("name_1").catch(() => {});
  }
}).catch(() => {});

module.exports = Currency;
