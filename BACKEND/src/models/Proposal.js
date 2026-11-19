const mongoose = require("mongoose");

const proposalSchema = new mongoose.Schema(
  {
    rel_type: {
      type: String,
      enum: ["lead", "customer"],
      required: true,
    },
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    // Human-readable display name for rel_id (Client.company or Lead.company/name),
    // resolved server-side since rel_id is a polymorphic ref with no populate path.
    proposal_to: {
      type: String,
    },
    // Recipient details filled from the customer/lead on the form (they used
    // to be dropped on save because these fields didn't exist).
    address: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    zip: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    gstin: { type: String, trim: true, uppercase: true, default: "" },
    vat: { type: String, trim: true, default: "" },
    // Assigned staff id and related project id from the form (were dropped
    // on save). Strings so an empty "" from the form never fails to cast.
    assigned: { type: String, default: "" },
    project: { type: String, default: "" },
    // Proposal number from Setup > Settings > Proposals (Prefix + Next Number);
    // older proposals have none and show PRO-<id>.
    number: { type: String },
    date: {
      type: Date,
      default: Date.now,
    },
    open_till: {
      type: Date,
    },
    status: {
      type: Number,
      default: 1, // 1=draft, 2=sent, 3=open, 4=revised, 5=declined, 6=accepted
    },
    content: {
      type: String, // HTML content
    },
    subtotal: {
      type: Number,
      default: 0,
    },
    total: {
      type: Number,
      default: 0,
    },
    discount_percent: {
      type: Number,
      default: 0,
    },
    total_tax: {
      type: Number,
      default: 0,
    },
    adjustment: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
    items: [
      {
        description: String,
        long_description: String,
        qty: { type: Number, default: 1 },
        rate: { type: Number, default: 0 },
        tax: { type: Number, default: 0 },
        tax_name: String,
      },
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    branch: {
      type: String,
      default: "",
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

proposalSchema.index(
  { tenant_id: 1, number: 1 },
  { unique: true, name: "tenant_id_1_number_1", partialFilterExpression: { number: { $type: "string" } } }
);

const Proposal = mongoose.model("Proposal", proposalSchema);

module.exports = Proposal;
