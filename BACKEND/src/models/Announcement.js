const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    showtousers: {
      type: Boolean,
      default: true,
    },
    showtostaff: {
      type: Boolean,
      default: true,
    },
    showname: {
      type: Boolean,
      default: true,
    },
    dateadded: {
      type: Date,
      default: Date.now,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

const Announcement = mongoose.model("Announcement", announcementSchema);

module.exports = Announcement;
