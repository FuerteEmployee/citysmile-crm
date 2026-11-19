const { FUERTE_PROMPT } = require("../prompts/fuerteai");

// Strips ```json fences Claude sometimes wraps JSON in despite instructions.
const stripFences = (text) => text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

// One-shot ask against a prebuilt CRM snapshot. Raw HTTP (not the SDK) per
// spec — API key from env only, never hardcoded.
async function ask(question, snapshot) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: [{ type: "text", text: FUERTE_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `CRM DATA:\n${snapshot}\n\nQUESTION: ${question}`,
        },
      ],
    }),
  });

  const raw = await response.json();
  if (raw.type === "error") {
    throw new Error(raw.error?.message || "Anthropic API error");
  }

  const text = raw.content?.find((b) => b.type === "text")?.text || "";
  let parsed = null;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    // leave parsed as null, keep raw text below — never throw on bad JSON
  }

  return {
    parsed,
    raw: text,
    usage: raw.usage,
    stop_reason: raw.stop_reason,
  };
}

module.exports = { ask };
