const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
    },
    hide_from_client: {
      type: Boolean,
      default: false,
    },
    imap_host: String,
    imap_username: String,
    imap_password: String,
    imap_encryption: {
      type: String,
      enum: ["tls", "ssl", "none"],
      default: "none",
    },
    folder: String,
    google_calendar_id: String,
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

departmentSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const Department = mongoose.model("Department", departmentSchema);

module.exports = Department;
