// Single Gemini entry point for every AI feature (CRM Agent assistant, Meeting
// Scribe, call summaries, call transcription, HRMS salary-slip analysis).
//
// `messages.create()` deliberately speaks the Anthropic Messages shape
// ({ system, tools, messages } in, { content, stop_reason, usage } out) so the
// existing tool-use loops in assistant_controller / meeting_controller and the
// AssistantChat.claude_history already stored in Mongo keep working unchanged —
// the translation to/from Gemini's contents/functionCall format happens here.
//
// When GROQ_API_KEY is set, text-only requests that still fail after the
// Gemini retries + fallback model are re-sent to Groq (see groqClient.js).
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const groq = require("./groqClient");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
// Used only when MODEL stays overloaded/rate-limited after retries.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";
const RETRYABLE = new Set([429, 500, 503, 504]);
const RETRY_DELAYS_MS = [1000];

// Gemini 3 rejects a replayed functionCall without its thoughtSignature; this is
// Google's documented placeholder for history that never had one (e.g. chats
// stored back when CRM Agent ran on Claude).
const SKIP_SIGNATURE = "skip_thought_signature_validator";

// Thinking tokens count against maxOutputTokens on Gemini, so the small
// Claude-era budgets (512/1024) would truncate replies — never go below this.
const MIN_OUTPUT_TOKENS = 8192;

class AIProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
  }
}

let ai = null;
const getAI = () => {
  if (!process.env.GEMINI_API_KEY) throw new AIProviderError("GEMINI_API_KEY is not configured on the server", 503);
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps an SDK call so every provider failure (bad key, quota, model gone,
// overload) surfaces as one error type callers can recognise. Transient
// overload/rate-limit errors ("high demand" 503s are common on new Flash
// models) are retried, then the request is re-sent on FALLBACK_MODEL.
const callGemini = async (params) => {
  const models = FALLBACK_MODEL && FALLBACK_MODEL !== params.model ? [params.model, FALLBACK_MODEL] : [params.model];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await getAI().models.generateContent({ ...params, model });
        // Some models occasionally answer STOP with zero parts (no text, no
        // tool call) — that's a model failure, not a reply; try the next model.
        if (response.candidates?.[0]?.content?.parts?.length || response.promptFeedback?.blockReason) {
          return response;
        }
        lastErr = { status: "EMPTY", message: `${model} returned an empty response` };
        break;
      } catch (err) {
        if (err instanceof AIProviderError) throw err;
        lastErr = err;
        if (!RETRYABLE.has(err?.status)) {
          throw new AIProviderError(err?.message || "Gemini request failed", err?.status);
        }
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    console.warn(`[Gemini] ${model} unavailable after retries (${lastErr?.status})${model !== models[models.length - 1] ? `, falling back to ${FALLBACK_MODEL}` : ""}`);
  }
  throw new AIProviderError(lastErr?.message || "Gemini request failed", lastErr?.status);
};

const toolResultText = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n");

// Anthropic-shaped messages -> Gemini contents.
const toContents = (messages) => {
  const toolNames = {}; // tool_use id -> tool name (functionResponse needs the name)
  return messages.map((msg) => {
    const role = msg.role === "assistant" ? "model" : "user";
    if (typeof msg.content === "string") return { role, parts: [{ text: msg.content }] };

    const parts = [];
    for (const block of msg.content || []) {
      if (block.type === "text" && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        toolNames[block.id] = block.name;
        parts.push({
          functionCall: { id: block.id, name: block.name, args: block.input || {} },
          thoughtSignature: block.thought_signature || SKIP_SIGNATURE,
        });
      } else if (block.type === "tool_result") {
        const output = toolResultText(block.content);
        parts.push({
          functionResponse: {
            id: block.tool_use_id,
            name: toolNames[block.tool_use_id] || "tool",
            response: block.is_error ? { error: output } : { output },
          },
        });
      }
    }
    if (!parts.length) parts.push({ text: "" });
    return { role, parts };
  });
};

// Gemini response -> Anthropic-shaped { content, stop_reason, usage }.
const fromResponse = (response) => {
  const candidate = response.candidates?.[0];
  const content = [];
  for (const part of candidate?.content?.parts || []) {
    if (part.thought) continue;
    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: part.functionCall.id || `call_${crypto.randomUUID()}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
      });
    } else if (part.text) {
      const last = content[content.length - 1];
      if (last?.type === "text") last.text += part.text;
      else content.push({ type: "text", text: part.text });
    }
  }

  if (!content.length && !candidate) {
    const reason = response.promptFeedback?.blockReason;
    throw new AIProviderError(reason ? `Gemini blocked the request (${reason})` : "Gemini returned no response");
  }

  const usage = response.usageMetadata || {};
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : candidate?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    },
  };
};

// Last resort for text-only work: if Gemini is down, out of quota or
// misconfigured, answer from Groq instead of failing the request. If Groq
// fails too, the original Gemini error is what callers see.
const withGroqFallback = async (geminiCall, groqCall) => {
  try {
    return await geminiCall();
  } catch (err) {
    if (!groq.isGroqConfigured()) throw err;
    console.warn(`[AI] Gemini failed (${err?.status || err?.message}), falling back to Groq ${groq.GROQ_MODEL}`);
    try {
      return await groqCall();
    } catch (groqErr) {
      console.error(`[AI] Groq fallback failed: ${groqErr?.message}`);
      throw err;
    }
  }
};

const createWithGemini = async ({ max_tokens, system, tools, messages }) => {
  const config = { maxOutputTokens: Math.max(max_tokens || 0, MIN_OUTPUT_TOKENS) };
  if (system) config.systemInstruction = system;
  if (tools?.length) {
    config.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.input_schema,
      })),
    }];
  }
  const response = await callGemini({ model: MODEL, contents: toContents(messages), config });
  return fromResponse(response);
};

const client = {
  messages: {
    // `model` is accepted for call-site compatibility; GEMINI_MODEL decides.
    create: (params) => withGroqFallback(
      () => createWithGemini(params),
      () => groq.createMessage({ ...params, max_tokens: Math.max(params.max_tokens || 0, MIN_OUTPUT_TOKENS) }),
    ),
  },
};

// Inline request bodies are capped at ~20MB, so larger media (long call
// recordings) goes through the Files API and is referenced by URI instead.
const INLINE_LIMIT_BYTES = 15 * 1024 * 1024;
const mediaPart = async (buffer, mimeType) => {
  if (buffer.length <= INLINE_LIMIT_BYTES) {
    return { inlineData: { mimeType, data: buffer.toString("base64") } };
  }
  try {
    const file = await getAI().files.upload({ file: new Blob([buffer], { type: mimeType }), config: { mimeType } });
    return { fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } };
  } catch (err) {
    throw new AIProviderError(`Gemini file upload failed: ${err?.message}`, err?.status);
  }
};

// Plain one-shot JSON generation (call summaries, salary-slip layout, …).
// `parts` may mix { text } and { inlineData: { mimeType, data } } entries.
const parseJson = (raw) => {
  const text = (raw || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new AIProviderError("AI response was not valid JSON");
  }
};

const generateJsonWithGemini = async ({ system, parts, maxOutputTokens }) => {
  const response = await callGemini({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      ...(system ? { systemInstruction: system } : {}),
      responseMimeType: "application/json",
      maxOutputTokens,
    },
  });
  return parseJson(response.text);
};

const generateJson = async ({ system, parts, maxOutputTokens = MIN_OUTPUT_TOKENS }) => {
  maxOutputTokens = Math.max(maxOutputTokens, MIN_OUTPUT_TOKENS);
  const geminiCall = () => generateJsonWithGemini({ system, parts, maxOutputTokens });
  // Audio/image/PDF parts need Gemini; only text-only prompts can go to Groq.
  if (!parts.every((p) => typeof p.text === "string")) return geminiCall();
  return withGroqFallback(geminiCall, async () => parseJson(await groq.generateJsonText({
    system,
    text: parts.map((p) => p.text).join("\n\n"),
    maxOutputTokens,
  })));
};

module.exports = { client, generateJson, mediaPart, MODEL, AIProviderError };
