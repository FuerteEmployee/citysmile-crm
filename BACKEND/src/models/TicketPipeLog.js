const mongoose = require("mongoose");

const ticketPipeLogSchema = new mongoose.Schema(
  {
    from_name: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    to: {
      type: String,
      required: true,
    },
    from_email: {
      type: String,
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["Success", "Blocked", "Spam", "Skipped", "Failed"],
      default: "Success",
    },
  },
  {
    timestamps: true,
  }
);

const TicketPipeLog = mongoose.model("TicketPipeLog", ticketPipeLogSchema);

module.exports = TicketPipeLog;
