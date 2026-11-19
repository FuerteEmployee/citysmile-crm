const mongoose = require("mongoose");

// Represents a custom module installed by uploading a .zip package.
// Built-in/core feature modules (Tasks, Projects, etc.) are NOT stored here —
// their on/off state lives in the generic Setting collection as `module_<key>`,
// same as before; this model only tracks uploaded add-on modules.
const moduleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
    },
    description: {
      type: String,
      default: "",
    },
    version: {
      type: String,
      default: "1.0.0",
    },
    filename: {
      type: String,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    installed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
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

const Module = mongoose.model("Module", moduleSchema);

module.exports = Module;
