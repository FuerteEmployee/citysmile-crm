const mongoose = require("mongoose");

const customFieldSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Owning company. null = legacy field from before custom fields were
    // per-company; scripts/migrate-custom-field-tenants.js assigns these.
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
    // Unique per company: the { tenant_id, slug } index is built by the migration
    // script, not declared here, so a server restart never rebuilds indexes on
    // the live DB by itself.
    slug: {
      type: String,
      required: true,
    },
    fieldto: {
      type: String,
      required: true,
      enum: [
        "customers",
        "contacts",
        "leads",
        "staff",
        "projects",
        "tasks",
        "tickets",
        "invoice",
        "estimate",
        "proposal",
        "contracts",
        "credit_note",
        "items",
        "expenses",
        "company",
        // Added to cover every module surfaced in the main sidebar, so a
        // custom field can be attached to any of them (previously only a
        // subset of sidebar modules had a matching enum value).
        "payments",
        "reports",
        "knowledge_base",
        "meetings",
        "subscriptions",
        "goals",
        "announcements",
      ],
    },
    type: {
      type: String,
      required: true,
      enum: [
        "input",
        "number",
        "textarea",
        "select",
        "multiselect",
        "checkbox",
        "date_picker",
        "date_picker_time",
        "colorpicker",
        "link",
      ],
    },
    options: {
      type: String, // Comma separated for select/multiselect/checkbox
    },
    field_order: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
    required: {
      type: Boolean,
      default: false,
    },
    show_on_pdf: {
      type: Boolean,
      default: false,
    },
    show_on_table: {
      type: Boolean,
      default: false,
    },
    show_on_client_portal: {
      type: Boolean,
      default: false,
    },
    disalow_client_to_edit: {
      type: Boolean,
      default: false,
    },
    only_admin: {
      type: Boolean,
      default: false,
    },
    bs_column: {
      type: Number,
      default: 12, // Bootstrap column width (1-12)
    },
    default_value: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

const CustomField = mongoose.model("CustomField", customFieldSchema);

module.exports = CustomField;
