const mongoose = require("mongoose");
const crypto = require("crypto");

const websiteLeadFormSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Public, unguessable token — the landing page posts to /api/public/website-leads/:key.
    key: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomBytes(16).toString("hex"),
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    total_leads: {
      type: Number,
      default: 0,
    },
    last_lead_at: Date,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("WebsiteLeadForm", websiteLeadFormSchema);
