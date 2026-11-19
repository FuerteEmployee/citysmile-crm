const SARVAM_BASE_URL = "https://api.sarvam.ai";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // Sarvam's own documented default

function authHeaders() {
  return {
    "api-subscription-key": process.env.SARVAM_API_KEY,
    "content-type": "application/json",
  };
}

// "codemix" mode (not "transcribe") specifically because Sarvam documents
// it as giving per-segment language detection for code-switched speech —
// "transcribe" mode's example responses only show one language_code for
// the whole file, which would silently violate the no-single-language-per-
// call requirement. language_code "unknown" is Sarvam's own auto-detect
// trigger — there's no "candidate languages" list parameter like Azure's
// continuous LID; auto-detect + codemix is the closest actual mechanism
// their API exposes for this.
async function createJob() {
  const res = await fetch(`${SARVAM_BASE_URL}/speech-to-text/job/v1`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "saaras:v3",
      mode: "codemix",
      language_code: "unknown",
      with_diarization: true,
      num_speakers: 2,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Sarvam job creation failed (HTTP ${res.status})`);
  return data;
}

// UNVERIFIED — Sarvam's public docs I could access describe this step only
// through their Python SDK's job.upload_files() abstraction, not a raw
// HTTP contract. This defensively tries the two shapes such APIs commonly
// use (a presigned upload URL returned by createJob, or a direct multipart
// POST to a job-scoped endpoint) and should be the first thing smoke-tested
// against a real account before relying on this in production.
async function uploadAudio(job, buffer) {
  const uploadUrl = job.input_signed_url || job.upload_url;
  if (uploadUrl) {
    const res = await fetch(uploadUrl, { method: "PUT", body: buffer });
    if (!res.ok) throw new Error(`Sarvam audio upload failed (HTTP ${res.status})`);
    return;
  }
  const form = new FormData();
  form.append("file", new Blob([buffer]), "recording.mp3");
  const res = await fetch(`${SARVAM_BASE_URL}/speech-to-text/job/v1/${job.job_id}/files`, {
    method: "POST",
    headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`Sarvam audio upload failed (HTTP ${res.status})`);
}

async function startJob(jobId) {
  const res = await fetch(`${SARVAM_BASE_URL}/speech-to-text/job/v1/${jobId}/start`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Sarvam job start failed (HTTP ${res.status})`);
}

async function pollUntilDone(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${SARVAM_BASE_URL}/speech-to-text/job/v1/${jobId}/status`, {
      headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `Sarvam status check failed (HTTP ${res.status})`);
    if (data.status === "done" || data.status === "completed") return data;
    if (data.status === "failed") throw new Error(data.error || "Sarvam transcription job failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Sarvam transcription job timed out");
}

async function downloadResult(jobId) {
  const res = await fetch(`${SARVAM_BASE_URL}/speech-to-text/job/v1/download-files`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ job_id: jobId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Sarvam result download failed (HTTP ${res.status})`);
  return data;
}

// Diarization gives numbered speakers, not roles — Sarvam doesn't tell us
// which speaker_id is the customer vs. staff. Best-effort heuristic: the
// caller is the one already talking when the call connects, so whichever
// speaker_id speaks first is labeled 'customer'. This is exactly the kind
// of uncertainty speakerSource='diarization' exists to flag to the UI —
// it's a labeled guess, not a claim of certainty.
function normalizeToUtterances(result) {
  const entries = result.diarized_transcript?.entries || [];
  const fallbackLanguage = result.language_code;

  let firstSpeakerId = null;
  const utterances = entries.map((entry) => {
    if (firstSpeakerId === null) firstSpeakerId = entry.speaker_id;
    return {
      speaker: entry.speaker_id === firstSpeakerId ? "customer" : "staff",
      speakerSource: "diarization",
      startMs: Math.round((entry.start_time_seconds || 0) * 1000),
      endMs: Math.round((entry.end_time_seconds || 0) * 1000),
      text: entry.transcript || "",
      detectedLanguage: entry.language_code || fallbackLanguage || null,
      // Not present per-entry in Sarvam's documented response shape —
      // left null (never fabricated) rather than guessed.
      languageConfidence: entry.language_probability ?? null,
      sttConfidence: null, // not part of Sarvam's batch response schema at all
    };
  });

  const languagesDetected = Array.from(
    new Set(utterances.map((u) => u.detectedLanguage).filter(Boolean))
  );

  return { utterances, languagesDetected, fullText: result.transcript || "" };
}

async function transcribeRecording(buffer) {
  const job = await createJob();
  const jobId = job.job_id || job.id;
  await uploadAudio(job, buffer);
  await startJob(jobId);
  await pollUntilDone(jobId);
  const result = await downloadResult(jobId);
  return normalizeToUtterances(result);
}

module.exports = { transcribeRecording };
