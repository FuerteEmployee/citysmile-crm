// Groq (OpenAI-compatible Chat Completions) — used by geminiClient.js as the
// last-resort provider when both Gemini models fail (quota, outage, bad key,
// empty replies). Text only: requests carrying audio/images/PDFs stay on Gemini.
//
// Like geminiClient, it speaks the Anthropic Messages shape at its edges so the
// assistant/meeting tool loops and stored AssistantChat.claude_history work
// unchanged whichever provider answered.
const crypto = require("crypto");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 1000];
// Free tier is 8000 tokens/min and one assistant turn (tool schemas included)
// is ~3.5k, so 429s are routine; wait out short ones Groq tells us about.
const MAX_RATE_LIMIT_WAIT_MS = 20000;

const retryDelayMs = (res, data, attempt) => {
  const header = Number(res.headers.get("retry-after"));
  const hinted = Number.isFinite(header) && header > 0
    ? header
    : Number(/try again in ([\d.]+)s/i.exec(data?.error?.message || "")?.[1]);
  return Number.isFinite(hinted) && hinted > 0 ? Math.ceil(hinted * 1000) + 250 : RETRY_DELAYS_MS[attempt];
};

const isGroqConfigured = () => Boolean(process.env.GROQ_API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callGroq = async (body) => {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GROQ_MODEL, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = Object.assign(new Error(data?.error?.message || `Groq request failed (${res.status})`), { status: res.status });
    // gpt-oss sometimes "calls" an undeclared tool (e.g. `json` when asked for
    // a JSON reply); Groq rejects that generation, but a re-roll usually works.
    const toolUseFailed = data?.error?.code === "tool_use_failed";
    if ((!RETRYABLE.has(res.status) && !toolUseFailed) || attempt >= RETRY_DELAYS_MS.length) break;
    const delay = retryDelayMs(res, data, attempt);
    if (delay > MAX_RATE_LIMIT_WAIT_MS) break;
    await sleep(delay);
  }
  throw lastErr;
};

const toolResultText = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n");

// Anthropic-shaped messages -> OpenAI chat messages. Tool results become
// separate `tool` messages, which must directly follow the assistant turn that
// issued the calls, so they're emitted before any text in the same user turn.
const toChatMessages = (system, messages) => {
  const out = system ? [{ role: "system", content: system }] : [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content || [];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    if (msg.role === "assistant") {
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const b of blocks.filter((b) => b.type === "tool_result")) {
        const output = toolResultText(b.content);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${output}` : output });
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
};

// OpenAI chat completion -> Anthropic-shaped { content, stop_reason, usage }.
const fromCompletion = (data) => {
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch { /* model sent malformed args */ }
    content.push({ type: "tool_use", id: call.id || `call_${crypto.randomUUID()}`, name: call.function?.name, input });
  }
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
};

const TOOL_HINT = "\n\nOnly call the tools you were given. Write your final answer (including any JSON) as a normal message, never as a tool call.";

const createMessage = async ({ max_tokens, system, tools, messages }) => {
  const data = await callGroq({
    messages: toChatMessages(tools?.length ? `${system || ""}${TOOL_HINT}` : system, messages),
    max_completion_tokens: max_tokens,
    ...(tools?.length
      ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
      : {}),
  });
  return fromCompletion(data);
};

// Returns the raw JSON text; geminiClient strips fences and parses it.
const generateJsonText = async ({ system, text, maxOutputTokens }) => {
  const data = await callGroq({
    messages: toChatMessages(system, [{ role: "user", content: text }]),
    response_format: { type: "json_object" },
    max_completion_tokens: maxOutputTokens,
  });
  return data.choices?.[0]?.message?.content || "";
};

module.exports = { isGroqConfigured, createMessage, generateJsonText, GROQ_MODEL };
