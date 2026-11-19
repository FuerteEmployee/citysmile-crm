const mongoose = require("mongoose");

const expenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
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

expenseCategorySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const ExpenseCategory = mongoose.model("ExpenseCategory", expenseCategorySchema);

// Drop the legacy global unique index on name if it exists so multi-tenant creation does not fail
ExpenseCategory.collection.getIndexes().then((indexes) => {
  if (indexes && indexes["name_1"]) {
    ExpenseCategory.collection.dropIndex("name_1").catch(() => {});
  }
}).catch(() => {});

module.exports = ExpenseCategory;
