const mongoose = require("mongoose");

// Phase 8 — daily CRM Agent usage per user, for rate limiting and cost visibility.
// One document per user per day (day = "YYYY-MM-DD").
const assistantUsageSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
      index: true,
    },
    day: { type: String, required: true },
    requests: { type: Number, default: 0 },
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

assistantUsageSchema.index({ user_id: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("AssistantUsage", assistantUsageSchema);
