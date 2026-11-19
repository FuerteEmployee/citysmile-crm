const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
    },
    amount: {
      type: Number,
      required: true,
    },
    interval: {
      type: String,
      enum: ["month", "year", "week"],
      default: "month",
    },
    interval_count: {
      type: Number,
      default: 1,
    },
    // Form fields that used to be dropped on save. Strings so an empty ""
    // from the form never fails to cast.
    plan: { type: String, default: "" },
    quantity: { type: Number, default: 1 },
    description: { type: String, default: "" },
    include_description: { type: Boolean, default: false },
    tax: { type: String, default: "" },
    tax2: { type: String, default: "" },
    terms: { type: String, default: "" },
    stripe_plan_id: String,
    stripe_subscription_id: String,
    status: {
      type: String,
      enum: ["active", "future", "in_trial", "past_due", "canceled", "unpaid"],
      default: "active",
    },
    date_subscribed: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const Subscription = mongoose.model("Subscription", subscriptionSchema);

module.exports = Subscription;
