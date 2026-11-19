const mongoose = require("mongoose");

const kbGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    description: String,
    color: {
      type: String,
      default: "#000000",
    },
    group_order: {
      type: Number,
      default: 0,
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

const KBGroup = mongoose.model("KBGroup", kbGroupSchema);

module.exports = KBGroup;
