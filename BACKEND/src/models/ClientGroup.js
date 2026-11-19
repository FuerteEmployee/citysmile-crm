const mongoose = require("mongoose");

const clientGroupSchema = new mongoose.Schema(
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
  },
  {
    timestamps: true,
  }
);

clientGroupSchema.index({ name: 1, tenant_id: 1 }, { unique: true });

const ClientGroup = mongoose.model("ClientGroup", clientGroupSchema);

module.exports = ClientGroup;
