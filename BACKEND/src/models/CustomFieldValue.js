const mongoose = require("mongoose");

const customFieldValueSchema = new mongoose.Schema(
  {
    fieldid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomField",
      required: true,
    },
    relid: {
      type: mongoose.Schema.Types.ObjectId,
      required: true, // ID of the entity (Staff, Client, etc.)
    },
    fieldto: {
      type: String,
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed, // Can be string, number, array
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for fast lookups
customFieldValueSchema.index({ fieldid: 1, relid: 1, fieldto: 1 }, { unique: true });

const CustomFieldValue = mongoose.model("CustomFieldValue", customFieldValueSchema);

module.exports = CustomFieldValue;
