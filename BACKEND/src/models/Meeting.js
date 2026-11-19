const mongoose = require("mongoose");

const meetingSchema = new mongoose.Schema(
  {
    topic: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    agenda: {
      type: String,
      required: true,
    },
    // References actual Staff accounts (not free text) so a meeting can be
    // matched to the staff members it was assigned to on their own side.
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
    date: {
      type: Date,
      required: true,
    },
    time: {
      type: String,
    },
    status: {
      type: String,
      default: "Scheduled",
    },
    summary: {
      type: String,
      default: "",
    },
    // English mirror of the Hindi summary, kept separately so meeting search
    // still works for English queries even though the primary summary is Hindi.
    summary_en: {
      type: String,
      default: "",
    },
    // Full structured CRM Agent Scribe output (agenda, decisions, action items,
    // open questions, suggested CRM updates, needs_review) — see meeting_controller.summarizeMeeting.
    scribe_data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    meeting_type: {
      type: String,
      default: "Internal",
    },
    branch: {
      type: String,
      default: "",
    },
    meeting_link: {
      type: String,
      default: "",
    },
    reminder_time: {
      type: Number,
      default: 15,
    },
    // Explicit confirmation (from the organizer, in-app) that participants were
    // told the meeting would be recorded — required before /recording accepts
    // an upload. Kept as an audit trail, not just a UI gate.
    recording_consent: {
      given: { type: Boolean, default: false },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
      at: { type: Date },
    },
    // Audio/video files captured via tab-share recording, stored in S3 — see
    // services/meetingRecordingService.js. `key` is the S3 object key; playback
    // always goes through a short-lived signed URL, never a stored public link.
    recordings: [
      {
        key: { type: String, required: true },
        type: { type: String, enum: ["audio", "video"], required: true },
        duration_seconds: { type: Number },
        size_bytes: { type: Number },
        uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        created_at: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

const Meeting = mongoose.model("Meeting", meetingSchema);

module.exports = Meeting;
