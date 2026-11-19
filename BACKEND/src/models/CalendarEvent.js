const mongoose = require("mongoose");

const calendarEventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    description: {
      type: String,
      default: "",
    },
    start: {
      type: Date,
      required: true,
    },
    end: {
      type: Date,
    },
    color: {
      type: String,
      default: "#3b82f6",
    },
    isPublic: {
      type: Boolean,
      default: false,
    },
    notification: {
      type: String,
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

const CalendarEvent = mongoose.model("CalendarEvent", calendarEventSchema);

module.exports = CalendarEvent;
