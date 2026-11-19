const cron = require("node-cron");
const Call = require("../models/Call");
const CallTranscript = require("../models/CallTranscript");
const { uploadRecording } = require("../services/s3RecordingService");
const { transcribeRecording } = require("../services/geminiTranscriptionService");
const { summarizeTranscript } = require("../services/callSummaryService");
const { emitCallUpdate } = require("../utils/callingAgentSocket");

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60 * 1000; // 1 minute
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
// If the process crashes/restarts mid-job, the row is stuck at
// transcriptionStatus='processing' with nothing else watching it — this is
// how it gets reclaimed instead of staying stuck forever, satisfying "never
// leave a row stuck in processing" even across a hard crash.
const STALE_PROCESSING_MS = 15 * 60 * 1000;

function nextBackoff(attempts) {
  return new Date(Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS));
}

// No Redis is provisioned anywhere in this stack (checked: no REDIS_* env
// var, no redis/ioredis client used anywhere in the codebase), and adding
// one means new infrastructure to provision and operate on a single EC2
// box for what's realistically modest call volume. This claims one row at
// a time via an atomic findOneAndUpdate — Mongo's atomicity is what makes
// this safe against two overlapping ticks, no broker needed. Processes one
// job per tick by design: correctness over throughput. If call volume ever
// outgrows a job every CALLING_AGENT_WORKER_CRON interval, that's the
// signal to revisit BullMQ+Redis, not before.
let isRunning = false;

async function processNextJob(io) {
  if (isRunning) return; // don't let a slow job overlap the next tick
  isRunning = true;
  try {
    const call = await Call.findOneAndUpdate(
      {
        providerRecordingUrl: { $exists: true, $ne: null },
        $or: [
          { transcriptionStatus: "pending", transcriptionNextAttemptAt: { $lte: new Date() } },
          {
            transcriptionStatus: "processing",
            updatedAt: { $lte: new Date(Date.now() - STALE_PROCESSING_MS) },
          },
        ],
      },
      { $set: { transcriptionStatus: "processing" }, $inc: { transcriptionAttempts: 1 } },
      { new: true }
    );
    if (!call) return; // nothing eligible this tick

    try {
      const { key, buffer } = await uploadRecording(call._id, call.providerRecordingUrl);
      call.recordingUrl = key;
      await call.save();

      const { utterances, languagesDetected, fullText } = await transcribeRecording(buffer);

      const callTranscript = await CallTranscript.findOneAndUpdate(
        { callId: call._id },
        { tenant_id: call.tenant_id, callId: call._id, utterances, languagesDetected, fullText },
        { upsert: true, new: true }
      );

      call.transcriptionStatus = "done";
      call.summaryStatus = "processing";
      await call.save();
      emitCallUpdate(io, call);

      const summary = await summarizeTranscript(fullText);
      callTranscript.summary = { ...summary, generatedAt: new Date() };
      await callTranscript.save();

      call.summaryStatus = "done";
      await call.save();
      emitCallUpdate(io, call);
    } catch (err) {
      // Never log the transcript body or a raw phone number here — only
      // the call id and the error message.
      console.error(`[CallingAgentWorker] call ${call._id} failed:`, err.message);
      call.transcriptionError = String(err.message).slice(0, 500);
      if (call.transcriptionAttempts >= MAX_ATTEMPTS) {
        call.transcriptionStatus = "failed";
        call.summaryStatus = "failed";
      } else {
        call.transcriptionStatus = "pending";
        call.transcriptionNextAttemptAt = nextBackoff(call.transcriptionAttempts);
      }
      await call.save();
      emitCallUpdate(io, call);
    }
  } finally {
    isRunning = false;
  }
}

function start(io) {
  const expr = process.env.CALLING_AGENT_WORKER_CRON || "*/30 * * * * *";
  if (!cron.validate(expr)) {
    console.error(`[CallingAgentWorker] Invalid cron expression "${expr}" — worker NOT scheduled.`);
    return;
  }
  cron.schedule(expr, () => {
    processNextJob(io).catch((err) => {
      console.error("[CallingAgentWorker] tick failed:", err.message);
    });
  });
  console.log(`[CallingAgentWorker] scheduled at "${expr}".`);
}

module.exports = { start, processNextJob };
