const mongoose = require("mongoose");

// One row per CRM Agent ("Hey CRM") event — wake word heard, command opened,
// browser speech errors, AI questions/answers/failures — so admins can see
// whether the assistant is actually working for their users and spot what to
// fix (misheard phrases, unmatched commands, blocked mics, provider errors).
// Auto-deleted after 90 days.
const VOICE_LOG_EVENTS = [
  "mic_on",       // user clicked the button to wake the assistant
  "mic_off",      // user clicked the button to stop the mic
  "wake",         // "Hey CRM" recognised
  "command",      // phrase matched a page and it was opened
  "no_access",    // phrase matched a page the user isn't allowed to open
  "timeout",      // awake, but no command was heard
  "speech_error", // browser speech recognition reported an error
  "ai_reply",     // AI answered (question in `heard`, answer in `result`)
  "ai_error",     // AI request failed
];

const assistantVoiceLogSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", index: true },
    user_name: { type: String, default: "" },
    event: { type: String, enum: VOICE_LOG_EVENTS, required: true, index: true },
    source: { type: String, enum: ["voice", "typed", ""], default: "" },
    heard: { type: String, default: "" },   // what the mic recognised / what was asked
    result: { type: String, default: "" },  // page opened, AI reply excerpt
    detail: { type: String, default: "" },  // error code / message
    page: { type: String, default: "" },    // page the user was on
    browser: { type: String, default: "" }, // short browser + OS label
    session_id: { type: String, default: "" }, // groups one page-load's events
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

assistantVoiceLogSchema.index({ tenant_id: 1, createdAt: -1 });
assistantVoiceLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const AssistantVoiceLog = mongoose.model("AssistantVoiceLog", assistantVoiceLogSchema);

module.exports = AssistantVoiceLog;
module.exports.VOICE_LOG_EVENTS = VOICE_LOG_EVENTS;
