// Builds the JSON body Exotel's Connect Applet (Dynamic URL) expects back
// from the incoming-call webhook. Field names verified against Exotel's own
// docs (support.exotel.com "Programmable Connect: Working with Connect
// Applet (Dynamic URL)"):
//   destination.numbers   - who to dial (E.164). Omit/empty -> Exotel hangs
//                            up on its own ("We didn't dial anyone" applet).
//   record                - bool, enable recording
//   recording_channels    - "single" | "dual"
//   max_ringing_duration  - seconds, 0-60
//   max_conversation_duration - seconds, 0-4500
//   start_call_playback   - { playback_to: "both"|"caller"|"callee", type: "text", value }
//
// UNVERIFIED, flag for a real test call once Exotel credentials exist:
// whether start_call_playback still plays when destination is empty (the
// not-found/hangup case below). Docs only confirm playback + a successful
// connect together; the reject-with-message combination isn't documented
// either way.
function buildConnectResponse({
  staffNumberE164,
  consentText,
  maxRingingDurationSeconds = 30,
  maxConversationDurationSeconds = 3600,
}) {
  return {
    destination: { numbers: [staffNumberE164] },
    record: true,
    recording_channels: "dual",
    max_ringing_duration: maxRingingDurationSeconds,
    max_conversation_duration: maxConversationDurationSeconds,
    start_call_playback: {
      playback_to: "both",
      type: "text",
      value: consentText,
    },
  };
}

function buildRejectResponse({ rejectionText }) {
  const response = {};
  if (rejectionText) {
    response.start_call_playback = {
      playback_to: "caller",
      type: "text",
      value: rejectionText,
    };
  }
  return response; // no `destination` -> Exotel hangs up
}

module.exports = { buildConnectResponse, buildRejectResponse };
