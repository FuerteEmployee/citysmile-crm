const mongoose = require("mongoose");

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    permissions: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Ordered priority list for where staff with this role land right after
    // login. `module` is a relative route slug (e.g. "leads", "dashboard") —
    // matches a MainSidebar item's url minus its "/admin" prefix, which the
    // frontend rewrites per portal (/staff, /admin). `permission` is that
    // item's permission key (e.g. "Leads"), used to skip an entry at login
    // time if a specific staff member can't actually view it (per-staff
    // overrides can differ from the role's own baseline), falling through
    // to the next entry. First entry whose permission the staff holds wins.
    default_modules: {
      type: [
        {
          module: { type: String, required: true },
          permission: { type: String, default: "" },
        },
      ],
      default: () => [{ module: "dashboard", permission: "" }],
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

const Role = mongoose.model("Role", roleSchema);

module.exports = Role;
