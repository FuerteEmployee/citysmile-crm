const mongoose = require("mongoose");

const ticketSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: true,
    },
    priority: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Priority",
    },
    status: {
      type: String, // Or ref to TicketStatus
      default: "open",
    },
    service: {
      type: String, // Optional service link
    },
    assigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    message: {
      type: String,
      default: "",
    },
    date: {
      type: Date,
      default: Date.now,
    },
    lastreply: {
      type: Date,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    tags: [String],
    cc: String,
    merge_ticket_no: String,
    replies: [
      {
        message: { type: String, required: true },
        is_note: { type: Boolean, default: false },
        staff: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        date: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

const Ticket = mongoose.model("Ticket", ticketSchema);

module.exports = Ticket;
