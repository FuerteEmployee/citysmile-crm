const mongoose = require("mongoose");

const RoleSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    icon: {
      type: String,
      default: "Shield",
    },
    color: {
      type: String,
      default: "bg-primary/10 text-primary border-primary/20",
    },
    permissions: [
      {
        type: String,
      },
    ],
    isSystemRole: {
      type: Boolean,
      default: false,
    },
    attendanceRequired: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Unique per tenant (a tenant's own custom roles), not globally — system-role
// names (isSystemRole: true, tenant_id: null) stay unique across the whole app.
RoleSchema.index({ tenant_id: 1, role: 1 }, { unique: true });

// Named "HRMSRole" (not "Role") because the main CRM already registers its own
// Mongoose model named "Role" (src/models/Role.js, tenant-scoped, Map-based
// permissions for the Setup > Roles feature). Two schemas sharing one Mongoose
// model name causes whichever loads first to silently win for every caller —
// this uses a distinct name so HRMS role lookups always get this flat-shape schema.
module.exports = (mongoose.models["HRMSRole"] || mongoose.model("HRMSRole", RoleSchema));
