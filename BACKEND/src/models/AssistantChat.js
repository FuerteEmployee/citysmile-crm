const mongoose = require("mongoose");

// Phase 6 — persistent CRM Agent conversations.
// One document per user: display messages power the chat panel UI, and
// claude_history is the raw Claude message array (including tool_use /
// tool_result blocks) so multi-turn context survives page reloads.
const assistantChatSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      unique: true,
      index: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
      index: true,
    },
    display: [
      {
        role: { type: String, enum: ["user", "assistant"], required: true },
        text: { type: String, required: true },
        at: { type: Date, default: Date.now },
      },
    ],
    claude_history: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AssistantChat", assistantChatSchema);
