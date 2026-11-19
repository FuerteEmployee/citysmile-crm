const mongoose = require("mongoose");

const noteSchema = new mongoose.Schema(
  {
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    rel_type: {
      type: String,
      required: true,
      default: "customer"
    },
    type: {
      type: String,
      enum: ["contacted", "not_contacted", "general"],
      default: "general",
    },
    description: {
      type: String,
      required: true,
    },
    addedfrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    dateadded: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Note", noteSchema);
