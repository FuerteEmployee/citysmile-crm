const mongoose = require("mongoose");

const timeEntrySchema = new mongoose.Schema(
  {
    task: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    project: {
      type: String,
    },
    member: {
      type: String,
    },
    hours: {
      type: Number,
      required: true,
    },
    billable: {
      type: Boolean,
      default: false,
    },
    date: {
      type: Date,
      required: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

const TimeEntry = mongoose.model("TimeEntry", timeEntrySchema);

module.exports = TimeEntry;
