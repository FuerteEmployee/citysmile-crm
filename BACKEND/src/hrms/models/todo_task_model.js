const mongoose = require("mongoose");

const todoTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    category: {
      type: String,
      enum: [
        "Sales",
        "Inventory",
        "Collections",
        "Purchase",
        "Service & Installation",
        "HR & Sales Team",
        "Finance",
        "Business Health",
        "Other"
      ],
      default: "Other"
    },
    priority: {
      type: String,
      enum: ["Critical", "High", "Medium", "Low"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed", "Ignored", "Snoozed"],
      default: "Pending",
    },
    relatedModule: {
      type: String,
      // e.g., "SalesInvoice", "Item", "PurchaseOrder"
    },
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      // The specific invoice or item ID
    },
    actionUrl: {
      type: String,
      // Route to open in the frontend
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
    },
    franchiseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Franchise",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    dueDate: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    isSystemGenerated: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    identifier: {
      type: String,
      // Used by generator to avoid duplicates (e.g., "low_stock_item_123")
      unique: true,
      sparse: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["TodoTask"] || mongoose.model("TodoTask", todoTaskSchema));
