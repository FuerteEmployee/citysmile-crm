const mongoose = require("mongoose");

const predefinedReplySchema = new mongoose.Schema({
  name: { type: String, required: true },
  message: { type: String, required: true },
  tenant_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tenant",
    index: true,
  },
}, { timestamps: true });

predefinedReplySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("PredefinedReply", predefinedReplySchema);
