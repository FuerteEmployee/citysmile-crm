const mongoose = require("mongoose");

const utteranceSchema = new mongoose.Schema(
  {
    speaker: {
      type: String,
      enum: ["customer", "staff"],
      required: true,
    },
    // 'channel' = each speaker was on its own recording channel, so the
    // attribution is exact. 'diarization' = a mono recording, speaker
    // inferred by the STT provider — render it, but the UI should flag it
    // as lower-confidence per the spec.
    speakerSource: {
      type: String,
      enum: ["channel", "diarization"],
      required: true,
    },
    startMs: { type: Number, required: true },
    endMs: { type: Number, required: true },
    text: { type: String, required: true },
    detectedLanguage: { type: String }, // BCP-47, e.g. 'gu-IN'
    languageConfidence: { type: Number, min: 0, max: 1 },
    sttConfidence: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const callTranscriptSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    callId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Call",
      required: true,
      index: true,
    },
    utterances: [utteranceSchema],
    // Concatenation of utterances[].text in order, kept in sync wherever
    // utterances is written — exists purely so the text index below has
    // one field to search across instead of reaching into the array.
    fullText: { type: String, default: "" },
    languagesDetected: [{ type: String }],
    summary: {
      text: { type: String },
      keyPoints: [{ type: String }],
      actionItems: [{ type: String }],
      sentiment: { type: String },
      generatedByModel: { type: String },
      generatedAt: { type: Date },
    },
  },
  {
    timestamps: true,
  }
);

callTranscriptSchema.index({ fullText: "text" });

const CallTranscript = mongoose.model("CallTranscript", callTranscriptSchema);

module.exports = CallTranscript;
