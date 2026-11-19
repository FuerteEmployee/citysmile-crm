const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    title: String,
    company: String,
    description: String,
    country: String,
    zip: String,
    city: String,
    state: String,
    address: String,
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    website: String,
    phonenumber: String,
    status: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeadStatus",
    },
    source: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeadSource",
    },
    assigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    addedfrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    is_public: {
      type: Boolean,
      default: false,
    },
    lead_value: {
      type: String,
      default: "0",
    },
    tags: {
      type: String,
      trim: true,
    },
    default_language: {
      type: String,
      default: "English",
    },
    contacted_today: {
      type: Boolean,
      default: false,
    },
    lastcontact: Date,
    dateadded: {
      type: Date,
      default: Date.now,
    },
    followup_date: Date,
    // Reset to false whenever followup_date is (re)set, so editing the date
    // re-arms the reminder cron instead of it staying silently "already
    // notified" from a previous value — see updateLead in lead_controller.js.
    followup_notified: {
      type: Boolean,
      default: false,
    },
    junk: { type: Boolean, default: false },
    lost: { type: Boolean, default: false },
    whatsapp_opt_out: { type: Boolean, default: false },
    meta_leadgen_id: {
      type: String,
      index: true,
    },
    // Which specific Meta Lead Ads form this lead came from (a Page can run
    // several forms at once with different questions) — lets the Leads page
    // split leads out "ads-wise" instead of lumping everything under one
    // generic "Meta Ads" source. form_name is a denormalized snapshot so it
    // still displays correctly even if the form is later renamed/deleted.
    meta_form_id: {
      type: String,
      index: true,
    },
    meta_form_name: String,
    // Ad that produced a Meta Lead Ads lead (from the leadgen webhook) — used
    // to resolve the campaign name through the tenant's connected ad account.
    meta_ad_id: String,
    // Every answer Meta returned for this lead (keyed by the form's question
    // `key`), kept even for questions that aren't mapped to a fixed Lead
    // column. This is what lets an admin "promote" a question into a real
    // CustomField column after the fact, backfilling already-imported leads,
    // instead of losing anything not recognized at import time.
    meta_field_data: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    salesPerson: {
      type: String,
      default: "",
    },
    branch: {
      type: String,
      default: "",
    },
    campaign: {
      type: String,
      trim: true,
      default: "",
    },
    // Last 10 digits of phonenumber — the dedupe key WhatsApp messages are
    // matched on. Kept in sync by the pre-save hook below.
    phone_last10: {
      type: String,
      default: undefined,
    },
    // How the lead entered the CRM when created by an integration (e.g.
    // "whatsapp"); empty for manually created/imported leads.
    origin: {
      type: String,
      default: "",
    },
    whatsapp_wa_id: String,
    whatsapp_first_message: String,
    whatsapp_last_message: String,
    whatsapp_last_message_at: Date,
    whatsapp_message_count: { type: Number, default: 0 },
    // Set only by the convert endpoint (see LeadConversion) — never from
    // generic create/update payloads.
    converted: { type: Boolean, default: false },
    converted_at: Date,
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
  },
  {
    timestamps: true,
  }
);

leadSchema.index({ tenant_id: 1, phone_last10: 1 });
leadSchema.index({ tenant_id: 1, converted: 1 });
// At most one WhatsApp-created lead per number per tenant, so two webhook
// deliveries racing for the same new number can't both create a lead.
leadSchema.index(
  { tenant_id: 1, phone_last10: 1 },
  {
    unique: true,
    partialFilterExpression: { origin: "whatsapp", phone_last10: { $type: "string" } },
    name: "uniq_whatsapp_lead_per_phone",
  }
);

leadSchema.pre("save", function (next) {
  if (this.isModified("phonenumber") || this.isNew) {
    const digits = String(this.phonenumber || "").replace(/\D/g, "");
    this.phone_last10 = digits.length >= 10 ? digits.slice(-10) : undefined;
  }
  next();
});

const Lead = mongoose.model("Lead", leadSchema);

module.exports = Lead;
