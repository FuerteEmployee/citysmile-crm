const mongoose = require("mongoose");

// This model stores the metadata for a conversation between participants
const chatConversationSchema = new mongoose.Schema(
  {
    isGroup: { type: Boolean, default: false },
    groupName: { type: String },
    groupAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
        required: true,
      },
    ],
    lastMessage: {
      content: String,
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      timestamp: { type: Date, default: Date.now },
    },
  },
  {
    timestamps: true,
  },
);

// Index for fast lookup of conversations matching specific participants
chatConversationSchema.index({ participants: 1 });

const ChatConversation = mongoose.model(
  "ChatConversation",
  chatConversationSchema,
);

// This model stores individual messages, optimized for high volume with deep indexes
const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatConversation",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      index: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Compound index for paginated history fetching: latest first
chatMessageSchema.index({ conversationId: 1, createdAt: -1 });

// Optimization compound index for counting unread messages at scale
chatMessageSchema.index({ conversationId: 1, receiver: 1, read: 1 });

const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

module.exports = { ChatConversation, ChatMessage };
