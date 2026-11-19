const { generateJson, mediaPart } = require("./geminiClient");

// Replaces the Sarvam batch STT job. Gemini transcribes the whole recording in
// one request, including code-switched Gujarati/Hindi/English and per-segment
// language tags, and returns the same { utterances, languagesDetected,
// fullText } shape CallTranscript expects.
const SYSTEM_PROMPT = `You transcribe recorded phone calls between a business's staff member and a customer, for a CRM.
Speech may mix Gujarati, Hindi, and English, sometimes within one sentence. Transcribe every word verbatim in the script it was spoken in (Gujarati script for Gujarati, Devanagari for Hindi, Latin for English) — never translate.
Split the call into utterances whenever the speaker changes. Label speakers "speaker_1" and "speaker_2" in the order they first speak.
Respond with ONLY a JSON object shaped exactly as:
{
  "utterances": [
    { "speaker": "speaker_1", "start": "MM:SS", "end": "MM:SS", "text": "...", "language": "gu-IN" | "hi-IN" | "en-IN" }
  ]
}
If the recording has no intelligible speech, return { "utterances": [] }.`;

// "MM:SS", "HH:MM:SS" or plain seconds -> milliseconds.
const toMs = (value) => {
  if (typeof value === "number") return Math.round(value * 1000);
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0) * 1000);
};

async function transcribeRecording(buffer) {
  const audio = await mediaPart(buffer, "audio/mpeg");
  const result = await generateJson({
    system: SYSTEM_PROMPT,
    parts: [{ text: "Transcribe this call recording." }, audio],
    maxOutputTokens: 32768,
  });

  // Diarization gives numbered speakers, not roles. Same best-effort heuristic
  // the Sarvam integration used: the caller is the one already talking when the
  // call connects, so whoever speaks first is labeled 'customer'.
  // speakerSource='diarization' flags this as a guess to the UI.
  let firstSpeaker = null;
  const utterances = (result.utterances || [])
    .filter((u) => u && typeof u.text === "string" && u.text.trim())
    .map((u) => {
      if (firstSpeaker === null) firstSpeaker = u.speaker;
      return {
        speaker: u.speaker === firstSpeaker ? "customer" : "staff",
        speakerSource: "diarization",
        startMs: toMs(u.start),
        endMs: toMs(u.end),
        text: u.text.trim(),
        detectedLanguage: u.language || null,
        // Gemini doesn't return confidence scores — left null, never guessed.
        languageConfidence: null,
        sttConfidence: null,
      };
    });

  const languagesDetected = Array.from(new Set(utterances.map((u) => u.detectedLanguage).filter(Boolean)));
  const fullText = utterances.map((u) => `${u.speaker === "customer" ? "Customer" : "Staff"}: ${u.text}`).join("\n");

  return { utterances, languagesDetected, fullText };
}

module.exports = { transcribeRecording };
