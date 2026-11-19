const mongoose = require("mongoose");

const GOAL_TYPES = [
  "total_income",
  "invoiced_amount",
  "convert_leads",
  "customer_num_exclude",
  "customer_num_include",
  "contracts_by_type_added",
  "contracts_by_type_start",
  "estimates_conversion",
];

const goalSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
      maxlength: [255, "Subject can be at most 255 characters"],
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    staff_member: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: [true, "Staff member is required"],
    },
    achievement: {
      type: Number,
      required: [true, "Achievement is required"],
      validate: {
        validator: (v) => Number.isFinite(v) && v > 0,
        message: "Achievement must be a number greater than 0",
      },
    },
    start_date: {
      type: Date,
      required: [true, "Start date is required"],
    },
    end_date: {
      type: Date,
      required: [true, "End date is required"],
      validate: {
        validator: function (v) {
          return !(this.start_date instanceof Date) || !v || v >= this.start_date;
        },
        message: "End date cannot be before start date",
      },
    },
    goal_type: {
      type: String,
      required: [true, "Goal type is required"],
      enum: { values: GOAL_TYPES, message: "Unknown goal type" },
    },
    // Calculated by services/goalProgressService.js — never taken from the client.
    progress: {
      type: Number,
      default: 0,
    },
    contract_type: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContractType",
    },
    description: {
      type: String,
      maxlength: [5000, "Description can be at most 5000 characters"],
    },
    notify_on_achieve: {
      type: Boolean,
      default: true,
    },
    notify_on_fail: {
      type: Boolean,
      default: true,
    },
    // Set once the achieved / failed notification has been sent, so it is sent only once.
    achieved_notified_at: Date,
    failed_notified_at: Date,
  },
  {
    timestamps: true,
  }
);

const Goal = mongoose.model("Goal", goalSchema);

module.exports = Goal;
module.exports.GOAL_TYPES = GOAL_TYPES;
