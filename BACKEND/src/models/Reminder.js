const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    date: {
      type: Date,
      required: true,
    },
    isnotified: {
      type: Boolean,
      default: false,
    },
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    rel_type: {
      type: String, // 'customer', 'lead', etc.
      required: true,
    },
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    notify_by_email: {
      type: Boolean,
      default: false,
    },
    // Follow-up lifecycle. Existing rows have no value and are treated as
    // "pending" everywhere (queries use $nin completed/dismissed).
    status: {
      type: String,
      enum: ["pending", "completed", "dismissed"],
      default: "pending",
    },
    completed_at: Date,
    completed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    outcome_note: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

reminderSchema.index({ tenant_id: 1, rel_type: 1, status: 1, date: 1 });
reminderSchema.index({ rel_id: 1, rel_type: 1 });

const Reminder = mongoose.model("Reminder", reminderSchema);

module.exports = Reminder;
