const mongoose = require("mongoose");

const saasPlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    billing_cycle: {
      type: String,
      enum: ["monthly", "yearly", "lifetime"],
      default: "monthly",
    },
    features: {
      max_users: { type: Number, default: 1 }, // -1 for unlimited
      max_storage_gb: { type: Number, default: 1 }, // -1 for unlimited
      max_customers: { type: Number, default: -1 },
    },
    module_access: {
      finance: { type: Boolean, default: true },
      leads: { type: Boolean, default: true },
      support: { type: Boolean, default: true },
      contracts: { type: Boolean, default: true },
      projects: { type: Boolean, default: true },
      tasks: { type: Boolean, default: true },
      chat: { type: Boolean, default: true },
      meetings: { type: Boolean, default: true },
      subscriptions: { type: Boolean, default: true },
      expenses: { type: Boolean, default: true },
      estimates: { type: Boolean, default: true },
      proposals: { type: Boolean, default: true },
      estimate_request: { type: Boolean, default: true },
      knowledge_base: { type: Boolean, default: true },
      reports: { type: Boolean, default: true },
      time_tracking: { type: Boolean, default: true },
      goals: { type: Boolean, default: true },
      announcements: { type: Boolean, default: true },
      calendar: { type: Boolean, default: true },
      bookmarks: { type: Boolean, default: true },
      hrms: { type: Boolean, default: true },
      sales: { type: Boolean, default: true },
      utility: { type: Boolean, default: true },
      website_forms: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: true },
    },
    trial_days: {
      type: Number,
      default: 14,
    },
    // How many days BEFORE expiry the renewal banner appears in the admin dashboard.
    // e.g. 30 → banner shows in the last 30 days; 90 → last 3 months.
    banner_warning_days: {
      type: Number,
      default: 30,
    },
    active: {
      type: Boolean,
      default: true,
    },
    is_popular: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const SaasPlan = mongoose.model("SaasPlan", saasPlanSchema);

module.exports = SaasPlan;
