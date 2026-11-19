const mongoose = require("mongoose");

const factoryLocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Location name is required"],
      trim: true,
    },
    code: {
      type: String,
      required: [true, "Location code is required"],
      trim: true,
      uppercase: true,
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    hrmsBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSBranch",
      default: null,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

factoryLocationSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

const FactoryLocation = mongoose.model("FactoryLocation", factoryLocationSchema);

module.exports = FactoryLocation;

