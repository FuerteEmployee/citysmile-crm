const mongoose = require("mongoose");

const ExpenseCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    isActive: { type: Boolean, default: true },
    // null = shared by every company; otherwise only the company that created it.
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
  },
  // autoIndex off: built by scripts/migrate-leavetype-expcat-tenant.js, which
  // also drops the old global name_1 unique index.
  { timestamps: true, autoIndex: false }
);

ExpenseCategorySchema.index({ tenant_id: 1, name: 1 }, { unique: true, name: "tenant_id_1_name_1" });

// Registered under a name distinct from the main CRM's own "ExpenseCategory"
// model (src/models/ExpenseCategory.js). Both used to register as
// "ExpenseCategory" — whichever loaded first in index.js won the shared
// Mongoose model registry, so this schema was silently never used; every
// query here (including the isActive filter below) actually ran against the
// main CRM's schema, which has no isActive field, so getAll() always found
// zero matches. Categories are per company (tenant_id), with tenant_id null
// meaning a shared category — see hrms/controllers/expense_category_controller.js.
module.exports = (mongoose.models["HRMSExpenseCategory"] || mongoose.model("HRMSExpenseCategory", ExpenseCategorySchema));
