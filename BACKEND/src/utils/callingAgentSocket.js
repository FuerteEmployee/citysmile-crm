// Shared by the webhook controller and the transcription worker — both
// need to push a Call update to the same two rooms. Reuses the existing
// generic "join" socket mechanism (see index.js) with no new backend wiring.
function emitCallUpdate(io, call) {
  if (!io || !call) return;
  io.to(`tenant-${call.tenant_id}`).emit("calling-agent:call-update", call);
  if (call.handledByStaffId) {
    io.to(String(call.handledByStaffId)).emit("calling-agent:call-update", call);
  }
}

module.exports = { emitCallUpdate };
