const mongoose = require("mongoose");
const ActivityLog = require("../models/ActivityLog");
const { registry } = require("../config/assistantModules");
const { runTools } = require("../controllers/assistant_controller");
const { MCP_MODULES, ANALYTICS_ACCESS, checkModuleAccess, checkAnalyticsAccess } = require("./access");

// The Claude connector reuses the in-app CRM Agent's tool implementations
// (assistant_controller.runTools) for the actual database work. This file is
// the stricter front door in front of them: input validation, CRM role
// permissions, SaaS-plan modules, read-only modules, a server-enforced
// two-step delete, and a "via Claude" activity log entry for every change.

const MODULE_KEYS = Object.keys(MCP_MODULES);
const WRITABLE_KEYS = MODULE_KEYS.filter((k) => MCP_MODULES[k].write);
const moduleList = (keys) => keys.map((k) => `${k} (${registry[k].label})`).join(", ");

const TOOLS = [
  {
    name: "search_records",
    title: "Search CRM records",
    description:
      "Search one CRM module's records by name, title or number (partial, case-insensitive). Returns up to 10 matches with their _id and key fields; use that _id in later update_record/delete_record calls. " +
      "Names are stored in English letters: transliterate Gujarati/Hindi script names first (e.g. 'શર્મા' -> 'Sharma') and drop honorifics like ji/bhai/sir. Modules: " + moduleList(MODULE_KEYS),
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", enum: MODULE_KEYS },
        query: { type: "string", description: "Name, title, number or partial text to search for" },
      },
      required: ["module", "query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "verify_record",
    title: "Verify a CRM record",
    description:
      "Check that a record exists and has every required field filled in. Identify it by exact id (preferred) or by name. Returns the record and any missing required fields. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", enum: MODULE_KEYS },
        id: { type: "string", description: "The record's exact _id, if known" },
        name: { type: "string", description: "Name/title to look the record up by, if id is not known" },
      },
      required: ["module"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_analytics",
    title: "CRM business numbers",
    description:
      "Business numbers for the user's company: revenue received (payments), total invoiced, outstanding unpaid invoices, total expenses, ad spend (marketing burning amount & cost per lead CPL), or record counts (customers, leads, tasks, invoices, tickets, projects). Amounts are in the company's currency.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: Object.keys(ANALYTICS_ACCESS) },
        period: {
          type: "string",
          enum: ["this_month", "last_month", "this_year", "all_time"],
          description: "Defaults to this_month. Ignored for counts.",
        },
      },
      required: ["metric"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "create_record",
    title: "Create a CRM record",
    description:
      "Create a new record in a simple CRM module: " + moduleList(WRITABLE_KEYS) + ". " +
      "Use the module's real field names, the same ones search_records returns (lead: name/company/email/phonenumber; client: company/email/phonenumber/city/country; task: name/description/startdate/duedate/priority; expense: expense_name/category/amount/date; meeting: topic/agenda/date). " +
      "Resolve relative dates (tomorrow, next Monday) to real dates first. Invoices, estimates, proposals, quotations, payments and other money records can't be created through Claude; give the user the CRM link instead.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", enum: WRITABLE_KEYS },
        fields: { type: "object", description: "Field name -> value for the new record" },
      },
      required: ["module", "fields"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "update_record",
    title: "Update a CRM record",
    description:
      "Change fields on an existing record in: " + moduleList(WRITABLE_KEYS) + ". Identify it by exact id (preferred, from search_records) or by name. " +
      "If more than one record matches the name, nothing is changed and the matches are returned: list them and ask the user which one, then call again with that id.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", enum: WRITABLE_KEYS },
        id: { type: "string", description: "The record's exact _id, if known" },
        name: { type: "string", description: "Name/title to look the record up by, if id is not known" },
        fields: { type: "object", description: "Field name -> new value, only the fields to change" },
      },
      required: ["module", "fields"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_record",
    title: "Delete a CRM record",
    description:
      "Delete a record by its EXACT id (never a name; use search_records first and show the record to the user). Deleting takes three calls and TWO separate explicit confirmations from the user, each in its own reply; the server refuses to skip a step. " +
      "Call 1: module + id only. Shows the record, deletes nothing. Ask the user to confirm. " +
      "Call 2, after the user's first yes: same id with confirm: true. Still deletes nothing. Ask for a second, final confirmation. " +
      "Call 3, only after the user's second yes: same id with confirm: true and confirm_final: true. This deletes it and cannot be undone. If the user says no at any point, stop.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", enum: WRITABLE_KEYS },
        id: { type: "string", description: "The record's exact _id" },
        confirm: { type: "boolean", description: "true from call 2, after the user's first yes" },
        confirm_final: { type: "boolean", description: "true only on call 3, after the user's second yes" },
      },
      required: ["module", "id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

const ACTION_FOR_TOOL = {
  search_records: "read",
  verify_record: "read",
  create_record: "create",
  update_record: "edit",
  delete_record: "delete",
};

// ── Input validation ──
// MCP arguments are arbitrary JSON: a value declared as a string can arrive
// as an object such as {"$ne": null}, which would turn a Mongo lookup into
// "match anything". Every value that reaches a query is checked here.

const PROTECTED_FIELDS = new Set([
  "_id", "__v", "tenant_id", "createdAt", "updatedAt",
  "password", "admin", "is_superadmin", "permissions", "role",
]);

const hasOperatorKeys = (value) => {
  if (Array.isArray(value)) return value.some(hasOperatorKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value).some((k) => k.startsWith("$") || k.includes(".") || hasOperatorKeys(value[k]));
  }
  return false;
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const validateInput = (name, input) => {
  if (!isPlainObject(input)) return "Arguments must be an object.";
  if (name === "get_analytics") {
    if (!ANALYTICS_ACCESS[input.metric]) return `metric must be one of: ${Object.keys(ANALYTICS_ACCESS).join(", ")}`;
    if (input.period !== undefined && !["this_month", "last_month", "this_year", "all_time"].includes(input.period)) {
      return "period must be this_month, last_month, this_year or all_time";
    }
    return null;
  }
  if (typeof input.module !== "string" || !MCP_MODULES[input.module]) return `module must be one of: ${MODULE_KEYS.join(", ")}`;
  if (input.id !== undefined && (typeof input.id !== "string" || !mongoose.isValidObjectId(input.id))) {
    return "id must be a record _id string as returned by search_records.";
  }
  for (const key of ["query", "name"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) return `${key} must be a non-empty string.`;
  }
  if (name === "search_records" && !input.query) return "query is required.";
  if ((name === "verify_record" || name === "update_record") && !input.id && !input.name) return "Give either id or name.";
  if (name === "delete_record" && !input.id) return "delete_record needs the exact id. Call search_records first.";
  for (const key of ["confirm", "confirm_final"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") return `${key} must be true or false.`;
  }
  if (name === "create_record" || name === "update_record") {
    if (!isPlainObject(input.fields) || Object.keys(input.fields).length === 0) return "fields must be an object with at least one field.";
    if (hasOperatorKeys(input.fields)) return "Field names can't start with '$' or contain '.'.";
  }
  return null;
};

const cleanFields = (fields) => {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (!PROTECTED_FIELDS.has(k)) out[k] = v;
  return out;
};

// ── Server-enforced delete confirmations ──
// The tool description asks Claude for two confirmations, but a model can
// still send confirm_final on its first call. Each step is only accepted when
// the previous one happened for the same user + record in the last 10 minutes.
// In memory: a restart (or another PM2 instance) just means starting over,
// never an unconfirmed delete.
const DELETE_STEP_TTL_MS = 10 * 60 * 1000;
const deleteSteps = new Map(); // `${staffId}:${module}:${id}` -> { step, at }

const deleteStepKey = (req, input) => `${req.user._id}:${input.module}:${input.id}`;

const checkDeleteStep = (req, input) => {
  const key = deleteStepKey(req, input);
  const prev = deleteSteps.get(key);
  const prevStep = prev && Date.now() - prev.at < DELETE_STEP_TTL_MS ? prev.step : 0;
  const step = !input.confirm ? 1 : !input.confirm_final ? 2 : 3;
  if (step > prevStep + 1) {
    deleteSteps.delete(key);
    return {
      error:
        "Delete steps can't be skipped. Start again: call delete_record with only module and id, show the record to the user, and ask for confirmation.",
    };
  }
  return { step, key };
};

const recordDeleteStep = (key, step) => {
  if (step >= 3) deleteSteps.delete(key);
  else deleteSteps.set(key, { step, at: Date.now() });
  if (deleteSteps.size > 5000) {
    const cutoff = Date.now() - DELETE_STEP_TTL_MS;
    for (const [k, v] of deleteSteps) if (v.at < cutoff) deleteSteps.delete(k);
  }
};

// ── Activity log ──
const ACTION_VERB = { create_record: "created", update_record: "updated", delete_record: "deleted" };

const logChange = (req, toolName, input, resultText) => {
  const verb = ACTION_VERB[toolName];
  const match = /^(?:Created|Updated|Deleted) .+? "(.*)" \(id: ([a-f0-9]{24})\)\.$/.exec(resultText);
  if (!verb || !match) return;
  const who = [req.user.firstname, req.user.lastname].filter(Boolean).join(" ") || req.user.email;
  ActivityLog.create({
    description: `${who} ${verb} ${registry[input.module].label} "${match[1]}" via Claude`,
    staffid: req.user._id,
    rel_id: match[2],
    rel_type: input.module,
    tenant_id: req.user.tenant_id,
  }).catch((err) => console.error("[mcp] activity log failed:", err.message));
};

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Runs one MCP tool call for an authenticated connector user (req.user). */
const callTool = async (req, name, rawInput) => {
  const input = rawInput || {};
  if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);

  const invalid = validateInput(name, input);
  if (invalid) return text(invalid, true);

  const denied =
    name === "get_analytics"
      ? await checkAnalyticsAccess(req, input.metric)
      : await checkModuleAccess(req, input.module, ACTION_FOR_TOOL[name]);
  if (denied) return text(denied, true);

  const args = { ...input };
  if (name === "create_record" || name === "update_record") args.fields = cleanFields(input.fields);
  if (name === "create_record") {
    const schema = registry[input.module].Model.schema;
    for (const creatorField of ["created_by", "addedfrom"]) {
      if (schema.path(creatorField)?.instance === "ObjectId" && args.fields[creatorField] === undefined) {
        args.fields[creatorField] = req.user._id;
      }
    }
  }

  let deleteStep = null;
  if (name === "delete_record") {
    deleteStep = checkDeleteStep(req, input);
    if (deleteStep.error) return text(deleteStep.error, true);
  }

  const { toolResults } = await runTools([{ type: "tool_use", id: "mcp", name, input: args }], req, "Claude");
  const result = toolResults[0];
  const resultText = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

  if (!result.is_error) {
    if (deleteStep) recordDeleteStep(deleteStep.key, deleteStep.step);
    logChange(req, name, input, resultText);
  }
  return text(resultText, !!result.is_error);
};

module.exports = { TOOLS, callTool };
