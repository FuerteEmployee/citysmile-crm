const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // null = global default (super admin / platform level); set = that tenant's override
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// One value per setting name per tenant (and one global default per name)
settingSchema.index({ name: 1, tenant_id: 1 }, { unique: true });

const Setting = mongoose.model("Setting", settingSchema);

module.exports = Setting;
