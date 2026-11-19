// Seam for Phase 4 (async transcription worker). The call-ended webhook
// calls this instead of transcribing inline, so its own request can return
// immediately. Phase 4 fills in the real job-queue implementation (BullMQ+
// Redis or a Mongo-backed queue, per that phase's own investigation) —
// until then this just leaves the Call row at transcriptionStatus='pending'
// (its schema default), which is honest: nothing has processed it yet.
async function enqueueTranscriptionJob(call) {
  // TODO(Phase 4): push { callId: call._id } onto the real queue.
  return null;
}

module.exports = { enqueueTranscriptionJob };
