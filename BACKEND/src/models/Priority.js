const mongoose = require("mongoose");

const prioritySchema = new mongoose.Schema(
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

prioritySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const Priority = mongoose.model("Priority", prioritySchema);

module.exports = Priority;
