const axios = require("axios");

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || "v21.0";
const CACHE_TTL_MS = 5 * 60 * 1000;

// Keyed by tenant_id (string) — each tenant's WABA has its own approved
// template list, so a single shared cache (like the old single-tenant
// design) would leak one tenant's templates into another's dropdown.
const cache = new Map(); // tenantId -> { fetchedAt, templates }

const mapTemplate = (t) => {
  const bodyComponent = (t.components || []).find((c) => c.type === "BODY");
  const headerComponent = (t.components || []).find((c) => c.type === "HEADER");
  const body = bodyComponent?.text || "";
  // Highest placeholder number, not the match count: "{{1}} … {{1}}" is still one variable.
  const variableCount = Math.max(0, ...(body.match(/\{\{(\d+)\}\}/g) || []).map((m) => Number(m.replace(/\D/g, ""))));

  return {
    id: t.name,
    name: t.name,
    label: t.name.replace(/_/g, " "),
    language: t.language,
    category: t.category,
    status: t.status,
    requiresImage: headerComponent?.format === "IMAGE",
    requiresDocument: headerComponent?.format === "DOCUMENT",
    headerFormat: headerComponent?.format || null,
    headerText: headerComponent?.format === "TEXT" ? headerComponent.text || "" : "",
    footer: (t.components || []).find((c) => c.type === "FOOTER")?.text || "",
    rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : "",
    body,
    // {{1}} is always resolved from the lead's name; {{2}}+ are campaign-supplied.
    variables: Array.from({ length: variableCount }, (_, i) => ({
      index: i + 1,
      source: i === 0 ? "lead.name" : "campaign",
    })),
    source: "meta",
  };
};

// Follows Meta's paging so accounts with more than 100 templates get all of them.
const fetchFromMeta = async (integration) => {
  const all = [];
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${integration.waba_id}/message_templates`;
  let params = {
    access_token: integration.access_token,
    fields: "name,language,status,category,components,rejected_reason",
    limit: 100,
  };
  for (let page = 0; url && page < 10; page += 1) {
    const response = await axios.get(url, { params });
    all.push(...(response.data?.data || []));
    url = response.data?.paging?.next || null;
    params = undefined; // the "next" URL already carries every parameter
  }
  return all.map(mapTemplate);
};

const getMergedTemplates = async (integration, force = false) => {
  if (!integration) return [];
  const key = String(integration.tenant_id);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.templates;
  }

  try {
    const templates = await fetchFromMeta(integration);
    cache.set(key, { fetchedAt: Date.now(), templates });
    return templates;
  } catch (error) {
    console.error("[WA Template Sync] error:", JSON.stringify(error.response?.data || error.message));
    // Never throw to callers — an unreachable Meta API shouldn't break the campaigns UI.
    return cached?.templates || [];
  }
};

const warmCache = (integration) => getMergedTemplates(integration, true).catch(() => {});

// Submits a new template straight to Meta for review — CRM never stores or
// approves templates itself, it just saves the tenant a trip to WhatsApp
// Manager. Meta's own review turnaround (minutes to a day or two) still
// applies; the template shows up as PENDING here until Meta decides.
//
// Meta rejects any template whose body has {{n}} placeholders without example
// values, so `bodyExamples[i]` is sent for {{i+1}}. An IMAGE header needs a
// sample image uploaded first (see uploadHeaderSample) — `headerHandle`.
const createTemplate = async (
  integration,
  { name, category, language, body, header, footer, bodyExamples = [], headerType = "TEXT", headerHandle = null, headerExample = "" }
) => {
  const bodyComponent = { type: "BODY", text: body };
  const varCount = Math.max(0, ...(body.match(/\{\{(\d+)\}\}/g) || []).map((m) => Number(m.replace(/\D/g, ""))));
  if (varCount > 0) {
    const examples = Array.from({ length: varCount }, (_, i) => String(bodyExamples[i] ?? "").trim() || `Sample ${i + 1}`);
    bodyComponent.example = { body_text: [examples] };
  }
  const components = [bodyComponent];

  if (headerType === "IMAGE" && headerHandle) {
    components.unshift({ type: "HEADER", format: "IMAGE", example: { header_handle: [headerHandle] } });
  } else if (header) {
    const headerComponent = { type: "HEADER", format: "TEXT", text: header };
    if (/\{\{1\}\}/.test(header)) headerComponent.example = { header_text: [String(headerExample || "Sample").trim()] };
    components.unshift(headerComponent);
  }
  if (footer) components.push({ type: "FOOTER", text: footer });

  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${integration.waba_id}/message_templates`,
    { name, category, language: language || "en_US", components },
    { params: { access_token: integration.access_token } }
  );
};

// The Meta app the token belongs to (needed for the upload session below).
// Prefers the App ID saved on the connection, else asks Meta about the token.
const resolveAppId = async (integration) => {
  if (integration.app_id) return integration.app_id;
  const res = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`, {
    params: { input_token: integration.access_token, access_token: integration.access_token },
  });
  return res.data?.data?.app_id || null;
};

// Uploads a sample header image through Meta's Resumable Upload API and
// returns the handle a template's IMAGE header example must reference. The
// handle is only for Meta's review; every campaign still sends its own image.
const uploadHeaderSample = async (integration, file) => {
  const appId = await resolveAppId(integration);
  if (!appId) throw new Error("Could not find the Meta App ID for this number. Add it under Connect > Update Token.");

  const session = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads`, null, {
    params: {
      file_name: file.originalname || "header.jpg",
      file_length: file.size || file.buffer.length,
      file_type: file.mimetype || "image/jpeg",
      access_token: integration.access_token,
    },
  });
  const uploadId = session.data?.id;
  if (!uploadId) throw new Error("Meta did not start the image upload");

  const uploaded = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${uploadId}`, file.buffer, {
    headers: {
      Authorization: `OAuth ${integration.access_token}`,
      file_offset: "0",
      "Content-Type": file.mimetype || "image/jpeg",
    },
    maxBodyLength: Infinity,
  });
  if (!uploaded.data?.h) throw new Error("Meta did not return an image handle");
  return uploaded.data.h;
};

module.exports = { getMergedTemplates, warmCache, createTemplate, uploadHeaderSample };
