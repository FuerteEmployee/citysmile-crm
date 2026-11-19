const mongoose = require("mongoose");

const metaQuestionSchema = new mongoose.Schema(
  { key: String, label: String, type: String },
  { _id: false }
);

const metaFormSchema = new mongoose.Schema(
  {
    form_id: { type: String, required: true },
    name: String,
    status: String,
    // The form's own question list (key = the field name Meta reports in a
    // lead's field_data, label = the human-readable question text shown to
    // the person who filled out the ad). Only populated once fetchForms()
    // requests it — lets Setup > Leads > Meta Forms show "which questions
    // does this specific form ask" instead of just name/id/status.
    questions: [metaQuestionSchema],
  },
  { _id: false }
);

const metaIntegrationSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    // Unique per page (not per tenant) so one tenant can connect several Pages,
    // each with its own token, running in parallel. The webhook receiver looks
    // up the integration by page_id alone, so a Page can only ever belong to
    // one tenant at a time.
    page_id: {
      type: String,
      required: true,
      unique: true,
    },
    page_name: String,
    page_access_token: {
      type: String,
      required: true,
    },
    forms: [metaFormSchema],
    connected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    last_synced: Date,
  },
  {
    timestamps: true,
  }
);

const MetaIntegration = mongoose.model("MetaIntegration", metaIntegrationSchema);

module.exports = MetaIntegration;
