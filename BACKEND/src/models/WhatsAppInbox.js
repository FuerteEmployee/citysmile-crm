const mongoose = require("mongoose");

// One row per message, both directions — the conversation thread for a
// contact is every row sharing the same (tenant_id, mobile).
const whatsAppInboxSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    from: {
      // Full international number as Meta sends it, e.g. 919876543210
      type: String,
      required: true,
    },
    mobile: {
      // Last-10-digit lookup key, matched against Lead.phonenumber
      type: String,
      required: true,
    },
    sender_name: {
      type: String,
      default: "",
    },
    message: {
      type: String,
      default: "",
    },
    msg_type: {
      type: String,
      enum: ["text", "image", "document", "audio", "video", "sticker", "location", "other"],
      default: "text",
    },
    wa_message_id: {
      type: String,
      index: true,
      sparse: true,
    },
    media_url: {
      type: String,
      default: null,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
    },
    direction: {
      type: String,
      enum: ["in", "out"],
      default: "in",
    },
    reply_status: {
      type: String,
      enum: ["pending", "read", "replied", "auto_replied", "ignored"],
      default: "pending",
    },
    reply_text: {
      type: String,
      default: null,
    },
    reply_at: {
      type: Date,
      default: null,
    },
    replied_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    auto_replied: {
      type: Boolean,
      default: false,
    },
    // Outbound-only — inbound rows stay at the default.
    delivery_status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed"],
      default: "sent",
    },
    received_at: {
      type: Date,
      required: true,
    },
    // Set when creating/updating the CRM lead for this inbound message
    // failed, so the failure is visible on the message instead of silent.
    lead_sync_error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

whatsAppInboxSchema.index({ tenant_id: 1, mobile: 1, received_at: 1 });
whatsAppInboxSchema.index({ tenant_id: 1, reply_status: 1, received_at: 1 });
whatsAppInboxSchema.index({ tenant_id: 1, direction: 1, mobile: 1, received_at: 1 });
whatsAppInboxSchema.index({ lead_id: 1 });

const WhatsAppInbox = mongoose.model("WhatsAppInbox", whatsAppInboxSchema);

module.exports = WhatsAppInbox;
