const mongoose = require("mongoose");

const vaultEntrySchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    server: {
      type: String,
      required: true,
    },
    port: String,
    username: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    description: String,
    visibility: {
      type: String,
      enum: ["all_staff", "admins", "self"],
      default: "all_staff",
    },
    share_in_projects: {
        type: Boolean,
        default: false
    },
    created_by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff"
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

const VaultEntry = mongoose.model("VaultEntry", vaultEntrySchema);

module.exports = VaultEntry;
