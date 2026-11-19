const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema(
  {
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    rel_type: {
      type: String, // 'customer', 'project', 'task', etc.
      required: true,
    },
    file_name: {
      type: String,
      required: true,
    },
    filetype: {
      type: String,
    },
    size: {
      type: Number,
    },
    visible_to_customer: {
      type: Boolean,
      default: false,
    },
    attachment_key: {
        type: String,
    },
    dateadded: {
      type: Date,
      default: Date.now,
    },
    addedfrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
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

const File = mongoose.model("File", fileSchema);

module.exports = File;
