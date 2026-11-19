const mongoose = require("mongoose");
const { TENANT_FEATURE_KEYS, allowedFeatures } = require("../config/tenantFeatures");

const tenantSchema = new mongoose.Schema(
  {
    company_name: {
      type: String,
      required: true,
      trim: true,
    },
    subdomain: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
      sparse: true,
    },
    // Short code for this company's own login link on the shared domain
    // (e.g. crm.beontimeofficial.com/admin/login?company=ap). Only picks the
    // pre-login branding (logo/name/favicon) — it never decides who may log
    // in, unlike subdomain/custom_domains. Set by the super admin.
    login_code: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Login code may only use letters, numbers and single dashes"],
      maxlength: 40,
    },
    // Full frontend hostnames (e.g. "erp.trinetratechnoworld.com") that
    // belong exclusively to this tenant. Used to lock login + branding to
    // this tenant on that domain. Leave empty for tenants sharing a generic
    // multi-tenant domain (e.g. crm.beontimeofficial.com).
    custom_domains: {
      type: [String],
      default: [],
      set: (domains) =>
        Array.isArray(domains)
          ? [...new Set(domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))]
          : [],
    },
    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SaasPlan",
    },
    status: {
      type: String,
      enum: ["active", "inactive", "trial", "expired"],
      default: "trial",
    },
    trial_ends_at: {
      type: Date,
    },
    billing_cycle_start: {
      type: Date,
    },
    billing_cycle_end: {
      type: Date,
    },
    owner_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff", // The main admin of this tenant
    },
    settings: {
      theme: { type: String, default: "light" },
      currency: { type: String, default: "USD" },
      timezone: { type: String, default: "UTC" },
    },
    // Per-tenant override of the left sidebar menu (title/order/group/etc).
    // Empty/absent = this tenant uses the global MainSidebar list untouched.
    // Any non-empty array here fully replaces the global list for this
    // tenant's users only — see mainsidebar_controller.getSidebarItems.
    sidebar_config: {
      type: [
        {
          // Each item keeps its own real ObjectId (Mongoose default) so the
          // Setup > Main Sidebar edit/delete/reorder endpoints can address
          // it directly — see mainsidebar_controller.js's tenant-scoped
          // branches, which resolve an id against this array before falling
          // back to the global MainSidebar collection.
          title: { type: String, required: true, trim: true },
          url: { type: String, required: true },
          icon: { type: String, default: "Circle" },
          // "Main" renders as a standalone top-level item; any other value
          // (e.g. "Sales") nests it under that collapsible section instead.
          group: {
            type: String,
            enum: ["Main", "Customers", "Sales", "Management", "Utilities", "Reports", "Setup", "HRMS"],
            default: "Main",
          },
          permission: { type: String, default: "" },
          order: { type: Number, default: 0 },
          // When set, this "Main" item renders inline as a collapsible at
          // its custom position (instead of a plain link) whose children
          // are that group's live, real MainSidebar items — e.g. "HRMS" at
          // whatever position the tenant picked, still expandable to Staff
          // Directory/Attendance/etc. See AppSidebar.tsx's renderItems.
          childGroup: {
            type: String,
            enum: ["HRMS", "Reports", "Utilities", "QuotationMaker"],
          },
          // When true, this item shows no drag handle and is excluded from
          // the sortable context — the tenant asked for it to stay at
          // whatever position it's in and never be repositioned again,
          // while every other (unlocked) item stays freely reorderable.
          locked: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    // Per-tenant list of HRMS sub-feature keys to hide from this tenant's
    // users only (e.g. "targets", "incentive_slabs"). Empty/absent = this
    // tenant sees every HRMS sub-feature normally. Checked in EmployeePage.tsx
    // and AppRoutes.tsx on the frontend.
    hidden_hrms_features: {
      type: [String],
      default: [],
    },
    // Per-tenant opt-in list of beta/preview UI features (e.g.
    // "new_roles_layout" — the redesigned Setup > Roles & Permissions page).
    // Empty/absent = this tenant sees the standard/previous UI for that
    // feature. Checked in SetupRoles.tsx on the frontend.
    enabled_beta_features: {
      type: [String],
      default: [],
    },
    // Optional add-on features the super admin has enabled for this tenant
    // (see src/config/tenantFeatures.js). Enforced on the backend by
    // requireTenantFeature and read by the frontend from user.tenant.
    enabled_features: {
      type: [{ type: String, enum: TENANT_FEATURE_KEYS }],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// The browser (login / me payloads) only ever sees add-ons this company is
// allowed to have on this server (config/tenantFeatures RESTRICTED_FEATURES).
tenantSchema.set("toJSON", {
  transform: (doc, ret) => {
    if (Array.isArray(ret.enabled_features)) ret.enabled_features = allowedFeatures(ret._id, ret.enabled_features);
    return ret;
  },
});

const Tenant = mongoose.model("Tenant", tenantSchema);

module.exports = Tenant;
