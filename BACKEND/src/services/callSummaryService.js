const { generateJson, MODEL } = require("./geminiClient");

const SYSTEM_PROMPT = `You summarize customer support/sales phone call transcripts for a CRM.
The transcript may mix Gujarati, Hindi, and English, sometimes within the
same sentence. Write your entire summary in English regardless of what
language was spoken, but quote short original-language phrases verbatim
(in their original script) wherever a translation would lose meaning —
e.g. an idiom, a specific promise, or an emotionally significant phrase.

Respond with ONLY a JSON object, no prose outside it, shaped exactly as:
{
  "text": "one paragraph summary of the call",
  "keyPoints": ["short bullet", ...],
  "actionItems": ["concrete follow-up task", ...],
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}`;

async function summarizeTranscript(fullText) {
  const parsed = await generateJson({
    system: SYSTEM_PROMPT,
    parts: [{ text: `CALL TRANSCRIPT:\n${fullText}` }],
  });

  return {
    text: parsed.text || "",
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
    sentiment: parsed.sentiment || "neutral",
    generatedByModel: MODEL,
  };
}

module.exports = { summarizeTranscript };
