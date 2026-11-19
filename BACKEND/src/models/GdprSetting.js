const mongoose = require("mongoose");

const gdprSettingSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

const GdprSetting = mongoose.model("GdprSetting", gdprSettingSchema);

module.exports = GdprSetting;
