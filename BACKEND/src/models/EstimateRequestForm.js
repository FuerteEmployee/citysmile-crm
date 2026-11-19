const mongoose = require("mongoose");

const estimateRequestFormSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    language: {
      type: String,
      default: "English",
    },
    status: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EstimateStatus",
    },
    responsible: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    branding: {
      submit_btn_text: {
        type: String,
        default: "Submit",
      },
      submit_btn_bg_color: {
        type: String,
        default: "#84c529",
      },
      submit_btn_text_color: {
        type: String,
        default: "#ffffff",
      },
    },
    submission: {
      type: {
        type: String,
        enum: ["message", "redirect"],
        default: "message",
      },
      message: {
        type: String,
      },
      redirect_url: {
        type: String,
      },
    },
    notifications: {
      enable: {
        type: Boolean,
        default: true,
      },
      type: {
        type: String,
        enum: ["specific_staff", "roles", "responsible"],
        default: "specific_staff",
      },
      staff_to_notify: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Staff",
        },
      ],
      roles_to_notify: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Role",
        },
      ],
    },
    fields: [
      {
        type: { type: String, required: true },
        label: { type: String, required: true },
        name: { type: String },
        required: { type: Boolean, default: false },
        options: [String],
        placeholder: { type: String },
        className: { type: String },
      },
    ],
  },
  {
    timestamps: true,
  }
);

const EstimateRequestForm = mongoose.model(
  "EstimateRequestForm",
  estimateRequestFormSchema
);

module.exports = EstimateRequestForm;
