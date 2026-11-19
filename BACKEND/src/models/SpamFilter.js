const mongoose = require("mongoose");

const spamFilterSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["sender", "subject", "phrase"],
      default: "sender",
    },
    value: {
      type: String,
      required: true,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
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

spamFilterSchema.index({ tenant_id: 1, type: 1, value: 1 }, { unique: true });

const SpamFilter = mongoose.model("SpamFilter", spamFilterSchema);

module.exports = SpamFilter;
