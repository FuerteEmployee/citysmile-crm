const mongoose = require("mongoose");

const translationSchema = new mongoose.Schema(
  { subject: String, message: String },
  { _id: false }
);

const emailTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  // Groups templates into the sections shown on the Setup > Email Templates
  // page (Tickets, Estimates, Contracts, ...).
  module: { type: String, required: true, index: true },
  active: { type: Boolean, default: true },
  from_name: { type: String, default: "" },
  plaintext: { type: Boolean, default: false },
  // Per-language override, e.g. { "French": { subject, message } }. English
  // uses the top-level subject/message fields above.
  translations: {
    type: Map,
    of: translationSchema,
    default: {},
  },
}, { timestamps: true });

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);
