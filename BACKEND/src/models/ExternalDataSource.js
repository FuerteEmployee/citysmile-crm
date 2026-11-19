const mongoose = require("mongoose");

const headerSchema = new mongoose.Schema(
  { key: String, value: String },
  { _id: false }
);

const externalDataSourceSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    // Admin-chosen label — shown as the Dashboard widget/table title.
    name: {
      type: String,
      required: true,
      trim: true,
    },
    api_url: {
      type: String,
      required: true,
      trim: true,
    },
    method: {
      type: String,
      enum: ["GET", "POST"],
      default: "GET",
    },
    // Sent as X-API-Key / X-API-Password headers when calling api_url —
    // kept as two plain fields (not a generic key/value list) so the Setup
    // UI can stay a simple pair of masked inputs for a non-technical admin.
    api_key: String,
    api_password: String,
    // Internal, not yet exposed as a multi-row editor in the UI — lets a
    // future "custom headers" admin control reuse this same field.
    headers: [headerSchema],
    // Dot-path into the JSON response to find the array to display
    // (e.g. "data.items"), for APIs that don't return a bare array.
    data_path: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ExternalDataSource", externalDataSourceSchema);
