const Call = require("../models/Call");
const CallTranscript = require("../models/CallTranscript");
const Client = require("../models/Client");
const Staff = require("../models/Staff");
const { getSignedPlaybackUrl } = require("../services/s3RecordingService");

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tenantFilter(req) {
  const filter = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
  return filter;
}

// Deliberately server-side filtered (unlike most list pages in this app,
// which fetch everything and filter client-side) — transcript full text is
// sensitive, and shipping every call's full transcript to the browser just
// to power a search box isn't something to do by default. Capped at 500
// rows; there's no pagination UI yet, so a tenant with more history than
// that only sees its most recent 500 until pagination is added.
async function getCalls(req, res) {
  try {
    const filter = tenantFilter(req);
    const { dateFrom, dateTo, status, matchStatus, customerId, staffId, language, search } = req.query;

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }
    if (status) filter.status = status;
    if (matchStatus) filter.matchStatus = matchStatus;
    if (customerId) filter.customerId = customerId;
    if (staffId) filter.handledByStaffId = staffId;

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const [transcriptMatches, matchingClients, matchingStaff] = await Promise.all([
        CallTranscript.find(
          { ...(filter.tenant_id ? { tenant_id: filter.tenant_id } : {}), $text: { $search: search } },
          { callId: 1 }
        ),
        // Customer column is shown by the joined Client's `company`, not the
        // raw customerId — resolve matching client ids so that column is
        // searchable too.
        Client.find({ company: re }).distinct("_id"),
        // Handled By is shown by the joined Staff's name.
        Staff.find({ $or: [{ firstname: re }, { lastname: re }] }).distinct("_id"),
      ]);

      filter.$or = [
        // Existing behavior: full-text match against the transcript body.
        { _id: { $in: transcriptMatches.map((t) => t.callId) } },
        // Caller column falls back from fromNumberE164 to fromNumber.
        { fromNumberE164: re },
        { fromNumber: re },
        // Status is a plain string enum field on the Call document itself.
        { status: re },
        // Transcript column shows transcriptionStatus (a processing-state
        // badge, e.g. "pending"/"done") — cheap plain-string match, distinct
        // from the transcript body text handled above.
        { transcriptionStatus: re },
        { customerId: { $in: matchingClients } },
        { handledByStaffId: { $in: matchingStaff } },
      ];
    }

    let calls = await Call.find(filter)
      .populate("customerId", "company phonenumber")
      .populate("handledByStaffId", "firstname lastname")
      .sort({ createdAt: -1 })
      .limit(500);

    // The table shows a language badge per row, which lives on the
    // transcript, not the call — one lightweight lookup rather than a
    // populate, since Call has no direct ref to CallTranscript.
    const transcripts = await CallTranscript.find(
      { callId: { $in: calls.map((c) => c._id) } },
      { callId: 1, languagesDetected: 1 }
    );
    const languagesByCallId = new Map(
      transcripts.map((t) => [String(t.callId), t.languagesDetected || []])
    );
    calls = calls.map((c) => ({
      ...c.toObject(),
      languagesDetected: languagesByCallId.get(String(c._id)) || [],
    }));

    if (language) {
      calls = calls.filter((c) => c.languagesDetected.includes(language));
    }

    res.json(calls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

async function getCallDetail(req, res) {
  try {
    const call = await Call.findOne({ _id: req.params.id, ...tenantFilter(req) })
      .populate("customerId", "company phonenumber email")
      .populate("handledByStaffId", "firstname lastname")
      .populate("candidateCustomerIds", "company phonenumber");
    if (!call) return res.status(404).json({ message: "Call not found" });

    const transcript = await CallTranscript.findOne({ callId: call._id });
    res.json({ call, transcript });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// The <audio> tag's src points here, never at S3 or Exotel directly — this
// redirects to a short-lived presigned URL, so nothing permanent/raw is
// ever visible in the page. Relies on the same cookie-based auth every
// other authenticated request in this app uses; a plain <audio src="..">
// GET still carries the auth cookie same as any other same-origin request.
async function streamRecording(req, res) {
  try {
    const call = await Call.findOne({ _id: req.params.id, ...tenantFilter(req) }).select("recordingUrl");
    if (!call || !call.recordingUrl) {
      return res.status(404).json({ message: "No recording available for this call" });
    }
    const signedUrl = await getSignedPlaybackUrl(call.recordingUrl);
    res.redirect(signedUrl);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// Backs the "resolve customer" action Phase 3 requires for an ambiguous
// match — staff picks the right one from candidateCustomerIds instead of
// the system silently guessing.
async function resolveCustomer(req, res) {
  try {
    const { customerId } = req.body || {};
    if (!customerId) return res.status(400).json({ message: "customerId is required" });

    const call = await Call.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!call) return res.status(404).json({ message: "Call not found" });
    if (!call.candidateCustomerIds.some((id) => String(id) === String(customerId))) {
      return res.status(400).json({ message: "That customer wasn't one of the candidates for this call" });
    }

    call.customerId = customerId;
    call.matchStatus = "matched";
    await call.save();
    res.json(call);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// Backs Phase 5's "manual retry" button on a failed transcription row.
async function retryTranscription(req, res) {
  try {
    const call = await Call.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!call) return res.status(404).json({ message: "Call not found" });
    if (!call.providerRecordingUrl) {
      return res.status(400).json({ message: "This call has no recording to transcribe" });
    }

    call.transcriptionStatus = "pending";
    call.summaryStatus = "pending";
    call.transcriptionError = null;
    call.transcriptionAttempts = 0;
    call.transcriptionNextAttemptAt = new Date();
    await call.save();

    res.json(call);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

module.exports = { getCalls, getCallDetail, streamRecording, resolveCustomer, retryTranscription };
