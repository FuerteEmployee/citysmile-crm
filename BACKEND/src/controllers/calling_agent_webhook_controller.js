const Call = require("../models/Call");
const Client = require("../models/Client");
const Staff = require("../models/Staff");
const CallingAgentIntegration = require("../models/CallingAgentIntegration");
const { findCustomersByPhone } = require("../services/callingAgentLookupService");
const { enqueueTranscriptionJob } = require("../services/callingAgentQueueService");
const { toE164 } = require("../utils/phoneNormalize");
const { buildConnectResponse, buildRejectResponse } = require("../utils/exotelResponse");
const { emitCallUpdate } = require("../utils/callingAgentSocket");

// The webhook_token IS the auth check (see CallingAgentIntegration.js) — an
// invalid/unknown token means either a forged request or a misconfigured
// Exotel dashboard, and either way there's no tenant to act on behalf of.
async function findIntegrationOrReject(req, res) {
  const { webhookToken } = req.params;
  const integration = await CallingAgentIntegration.findOne({
    webhook_token: webhookToken,
    active: true,
  });
  if (!integration) {
    res.status(401).json({ error: "Not authorized" });
    return null;
  }
  return integration;
}

// Resolves who to bridge to: the matched customer's assigned salesperson if
// they have a usable phone number, else the tenant's configured fallback.
async function resolveDestinationNumber(matchedClient, integration) {
  if (matchedClient && matchedClient.sales_person) {
    const staff = await Staff.findById(matchedClient.sales_person).select("phonenumber");
    const staffE164 = staff && toE164(staff.phonenumber);
    if (staffE164) return { number: staffE164, staffId: matchedClient.sales_person };
  }
  const fallbackE164 = integration.default_fallback_number
    ? toE164(integration.default_fallback_number)
    : null;
  return { number: fallbackE164, staffId: null };
}

// Shared by both the first-time decision and a retried/duplicate webhook —
// re-deriving the outcome is cheap and side-effect-free, so a retry just
// re-runs this rather than trying to reconstruct the answer from a stored
// row. Returns the Exotel JSON body plus the fields a NEW Call document
// would need (the caller decides whether to actually create one).
async function decideCallOutcome(callerNumber, integration) {
  const { e164, matchStatus, candidateClientIds } = await findCustomersByPhone(
    callerNumber,
    integration.tenant_id
  );

  const matchedClient =
    matchStatus === "matched" ? await Client.findById(candidateClientIds[0]) : null;

  const base = {
    fromNumberE164: e164,
    matchStatus,
    candidateCustomerIds: matchStatus === "ambiguous" ? candidateClientIds : [],
    customerId: matchedClient ? matchedClient._id : null,
  };

  if (matchStatus === "not_found") {
    return {
      ...base,
      status: "rejected_unknown_number",
      handledByStaffId: null,
      consentAnnouncementPlayed: false,
      recordingChannels: undefined,
      responseBody: buildRejectResponse({
        rejectionText:
          "Sorry, we couldn't find your number in our records. Please contact us through our website.",
      }),
    };
  }

  // matched or ambiguous — both connect; ambiguous just has no single
  // obviously-correct staff target, so it goes to the fallback number,
  // same as an unassigned matched customer would.
  const { number, staffId } = await resolveDestinationNumber(matchedClient, integration);
  return {
    ...base,
    status: number ? "ringing" : "failed",
    handledByStaffId: staffId,
    consentAnnouncementPlayed: Boolean(number),
    recordingChannels: number ? 2 : undefined,
    responseBody: number
      ? buildConnectResponse({ staffNumberE164: number, consentText: integration.consent_announcement_text })
      : buildRejectResponse({
          rejectionText: "Sorry, no one is available to take your call right now.",
        }),
  };
}


async function handleIncomingCall(req, res) {
  try {
    const integration = await findIntegrationOrReject(req, res);
    if (!integration) return;

    const { CallSid, CallFrom, CallTo } = req.query;
    if (!CallSid || !CallFrom) {
      return res.status(400).json(buildRejectResponse({}));
    }

    const existing = await Call.findOne({ providerCallId: CallSid });
    if (existing) {
      // Exotel retried the same webhook — answer consistently, but don't
      // create a second row for it.
      const outcome = await decideCallOutcome(CallFrom, integration);
      return res.json(outcome.responseBody);
    }

    const outcome = await decideCallOutcome(CallFrom, integration);
    const callDoc = {
      tenant_id: integration.tenant_id,
      providerCallId: CallSid,
      direction: "inbound",
      fromNumber: CallFrom,
      toNumber: CallTo,
      answeredAutomatically: false,
      startedAt: new Date(),
      ...outcome,
    };
    delete callDoc.responseBody;

    let call;
    try {
      call = await Call.create(callDoc);
    } catch (err) {
      if (err.code === 11000) {
        // Lost a race against a duplicate webhook delivery — someone else's
        // request already created the row, so just answer without creating
        // a second one (AC #6: replay must not duplicate).
        return res.json(outcome.responseBody);
      }
      throw err;
    }

    emitCallUpdate(req.app.get("io"), call);
    return res.json(outcome.responseBody);
  } catch (error) {
    console.error("calling-agent incoming webhook error:", error.message);
    return res.status(500).json(buildRejectResponse({}));
  }
}

// Exotel's Status values aren't fully enumerated in public docs (they
// mirror Twilio's vocabulary closely but this mapping should be checked
// against real callback payloads once a live Exotel account is connected).
function mapProviderStatus(providerStatus, conversationDurationSeconds) {
  const normalized = (providerStatus || "").toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "no-answer" || normalized === "canceled") return "missed";
  if (normalized === "busy") return "missed";
  if (normalized === "failed") return "failed";
  return conversationDurationSeconds > 0 ? "completed" : "missed";
}

async function handleCallEnded(req, res) {
  try {
    const integration = await findIntegrationOrReject(req, res);
    if (!integration) return;

    const { CallSid, EventType, Status, RecordingUrl, ConversationDuration } = req.body || {};
    if (!CallSid) return res.status(400).json({ error: "Missing CallSid" });

    // Only the terminal event carries final status/duration/recording.
    if ((EventType || "").toLowerCase() !== "terminal") {
      return res.status(200).json({ ok: true });
    }

    const call = await Call.findOne({ providerCallId: CallSid, tenant_id: integration.tenant_id });
    if (!call) {
      console.warn(`calling-agent call-ended webhook: no Call found for ${CallSid}`);
      return res.status(200).json({ ok: true });
    }

    const durationSeconds = Number(ConversationDuration) || 0;
    call.status = mapProviderStatus(Status, durationSeconds);
    call.durationSeconds = durationSeconds;
    call.endedAt = new Date();
    if (RecordingUrl) call.providerRecordingUrl = RecordingUrl;
    if (!call.answeredAt && durationSeconds > 0) call.answeredAt = call.startedAt;
    await call.save();

    if (call.providerRecordingUrl) {
      await enqueueTranscriptionJob(call);
    }

    emitCallUpdate(req.app.get("io"), call);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("calling-agent call-ended webhook error:", error.message);
    return res.status(500).json({ error: "Internal error" });
  }
}

module.exports = { handleIncomingCall, handleCallEnded };
