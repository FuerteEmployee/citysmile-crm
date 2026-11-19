const mongoose = require("mongoose");

// "Customer" in this codebase is the Client model (see Client.js) — Contact
// phone matches resolve up to their parent Client via Contact.userid, so
// customerId/candidateCustomerIds are always Client refs regardless of
// which collection's phoneE164 actually matched.
const callSchema = new mongoose.Schema(
  {
    // Every other collection in this app is tenant-scoped (it's a
    // multi-tenant CRM) — omitting this would leak call data across
    // tenants, so it's here even though the original field list didn't
    // call it out.
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },

    // Provider-agnostic name for what Exotel calls a CallSid.
    providerCallId: {
      type: String,
      required: true,
      unique: true,
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },

    fromNumber: { type: String, trim: true },
    fromNumberE164: { type: String, trim: true, index: true },
    toNumber: { type: String, trim: true },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    // Populated only when matchStatus === 'ambiguous' — every Client this
    // number could belong to, so the UI can offer a "resolve customer"
    // action instead of silently picking one.
    candidateCustomerIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Client",
      },
    ],
    matchStatus: {
      type: String,
      enum: ["matched", "not_found", "ambiguous"],
      required: true,
    },

    handledByStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    status: {
      type: String,
      enum: [
        "ringing",
        "answered",
        "rejected_unknown_number",
        "missed",
        "completed",
        "failed",
      ],
      required: true,
    },
    answeredAutomatically: { type: Boolean, default: false },

    startedAt: { type: Date },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number },

    // Our own private S3 reference, populated once the Phase 4 worker has
    // downloaded and re-stored the recording — never the provider's raw
    // URL (that's providerRecordingUrl below, used only by the worker to
    // fetch the file, and never sent to the frontend).
    recordingUrl: { type: String },
    providerRecordingUrl: { type: String },
    recordingChannels: { type: Number, enum: [1, 2] },

    transcriptionStatus: {
      type: String,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
    },
    transcriptionError: { type: String, default: null },
    summaryStatus: {
      type: String,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
    },
    // Retry/backoff bookkeeping for the Mongo-backed job queue (see
    // src/jobs/callingAgentTranscriptionWorker.js) — the worker only claims
    // rows where nextAttemptAt has passed, so a failed attempt doesn't get
    // hammered again immediately.
    transcriptionAttempts: { type: Number, default: 0 },
    transcriptionNextAttemptAt: { type: Date, default: Date.now },

    consentAnnouncementPlayed: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

callSchema.index({ tenant_id: 1, createdAt: -1 });

const Call = mongoose.model("Call", callSchema);

module.exports = Call;
