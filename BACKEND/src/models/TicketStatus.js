const mongoose = require("mongoose");

const ticketStatusSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    statusorder: {
      type: Number,
      default: 0,
    },
    color: {
      type: String,
      default: "#757575",
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

ticketStatusSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

const TicketStatus = mongoose.model("TicketStatus", ticketStatusSchema);

module.exports = TicketStatus;
