const mongoose = require("mongoose");

const purchaseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
    },
    code: {
      type: String,
      required: [true, "Category code is required"],
      trim: true,
      uppercase: true,
    },
    procurementType: {
      type: String,
      enum: ["READY", "JOBWORK", "MANUFACTURE"],
      required: [true, "Procurement type is required (READY, JOBWORK, MANUFACTURE)"],
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseCategory",
      default: null,
      index: true,
    },
    path: {
      // e.g. "MANUFACTURE/B/B-1" or "READY/HYD/HYD-VLV"
      type: String,
      required: true,
      index: true,
    },
    level: {
      // 1: Type root, 2: Category, 3: Subcategory, 4: Leaf/Item-group
      type: Number,
      required: true,
      min: [1, "Category level must be between 1 and 4"],
      max: [4, "The category tree is limited to a maximum of 4 levels"],
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique code per tenant
purchaseCategorySchema.index({ tenant_id: 1, code: 1 }, { unique: true });
purchaseCategorySchema.index({ tenant_id: 1, procurementType: 1, parentId: 1, sortOrder: 1 });
purchaseCategorySchema.index({ name: "text" });

const PurchaseCategory = mongoose.model("PurchaseCategory", purchaseCategorySchema);

module.exports = PurchaseCategory;

