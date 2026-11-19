const mongoose = require("mongoose");

const estimateRequestSchema = new mongoose.Schema(
  {
    form: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EstimateRequestForm",
      required: true,
    },
    status: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EstimateStatus",
    },
    assigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    firstname: {
      type: String,
      trim: true,
    },
    lastname: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    company: {
      type: String,
      trim: true,
    },
    form_data: [
      {
        label: String,
        value: mongoose.Schema.Types.Mixed,
        name: String,
        // Wrapped as { type: { type: String } } rather than a bare `type:
        // String` — Mongoose treats a bare "type" key on a schema-path
        // object as the SchemaType shorthand itself (collapsing the whole
        // object to that one type) instead of a sibling field named "type".
        type: { type: String },
      },
    ],
    connectPerson: {
      type: String,
      trim: true,
      default: "",
    },
    salesPerson: {
      type: String,
      trim: true,
      default: "",
    },
    items: [
      {
        description: { type: String, trim: true, default: "" },
        qty: { type: Number, default: 0 },
        rate: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    ],
    is_converted: {
      type: Boolean,
      default: false,
    },
    converted_to_estimate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Estimate",
    },
    converted_to_lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
    },
    date: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

estimateRequestSchema.pre("save", function (next) {
  if (this.isNew && !this.connectPerson) {
    this.connectPerson = `${this.firstname || ""} ${this.lastname || ""}`.trim();
  }
  next();
});

const EstimateRequest = mongoose.model("EstimateRequest", estimateRequestSchema);

module.exports = EstimateRequest;
