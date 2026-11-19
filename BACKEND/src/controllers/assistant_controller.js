const { client, MODEL, AIProviderError } = require("../services/geminiClient");
const Client = require("../models/Client");
const Task = require("../models/Task");
const Invoice = require("../models/Invoice");
const Ticket = require("../models/Ticket");
const Lead = require("../models/Lead");
const Project = require("../models/Project");
const Expense = require("../models/Expense");
const Payment = require("../models/Payment");
const AssistantChat = require("../models/AssistantChat");
const AssistantUsage = require("../models/AssistantUsage");
const Setting = require("../models/Setting");
const { MODULES, registry } = require("../config/assistantModules");
const { writeVoiceLogs } = require("./assistant_voice_log_controller");

// Mirrors Frontend/src/lib/voiceCommands.ts COMMAND_MAP — keep in sync whenever
// a module/route is added to or removed from the sidebar.
const NAVIGABLE_ROUTES = [
  { route: "/admin/dashboard", label: "Dashboard" },
  { route: "/admin/tasks", label: "Tasks" },
  { route: "/admin/leads", label: "Leads" },
  { route: "/admin/customers", label: "Customers" },
  { route: "/admin/contacts", label: "Contacts" },
  { route: "/admin/items", label: "Items" },
  { route: "/admin/activity", label: "Activity Logs" },
  { route: "/admin/projects", label: "Projects" },
  { route: "/admin/invoices", label: "Invoices" },
  { route: "/admin/expenses", label: "Expenses" },
  { route: "/admin/estimates", label: "Estimates" },
  { route: "/admin/proposals", label: "Proposals" },
  { route: "/admin/credit-notes", label: "Credit Notes" },
  { route: "/admin/purchases", label: "Purchases" },
  { route: "/admin/support", label: "Support" },
  { route: "/admin/chat", label: "Chat" },
  { route: "/admin/calendar", label: "Calendar" },
  { route: "/admin/meetings", label: "Meetings" },
  { route: "/admin/reports", label: "Reports" },
  { route: "/admin/time-tracking", label: "Attendance" },
  { route: "/admin/setup/staff", label: "Staff" },
  { route: "/admin/setup", label: "Setup" },
  { route: "/admin/setup/settings", label: "General Settings" },
  { route: "/admin/setup/leads/sources", label: "Lead Sources" },
  { route: "/admin/setup/leads/statuses", label: "Lead Statuses" },
  { route: "/admin/setup/finance/tax-rates", label: "Tax Rates" },
  { route: "/admin/setup/finance/currencies", label: "Currencies" },
  { route: "/admin/setup/finance/payment-modes", label: "Payment Modes" },
  { route: "/admin/setup/finance/expense-categories", label: "Expense Categories" },
  { route: "/admin/setup/support/departments", label: "Support Departments" },
  { route: "/admin/setup/customers/groups", label: "Customer Groups" },
  { route: "/admin/contracts", label: "Contracts" },
  { route: "/admin/payments", label: "Payments" },
  { route: "/admin/subscriptions", label: "Subscriptions" },
  { route: "/admin/goals", label: "Goals" },
  { route: "/admin/announcements", label: "Announcements" },
  { route: "/admin/knowledge-base", label: "Knowledge Base" },
  { route: "/admin/media", label: "Media" },
];

// Create-form routes the AI can open when a record is too complex to create
// directly (needs linked records the user picks in the form). Mirrors the
// frontend's CREATE_MAP in voiceCommands.ts.
const CREATE_FORM_ROUTES = [
  "/admin/tasks?new=1",
  "/admin/customers?new=1",
  "/admin/leads?new=1",
  "/admin/items?new=1",
  "/admin/knowledge-base?new=1",
  "/admin/meetings?new=1",
  "/admin/contracts?new=1",
  "/admin/purchases?new=1",
  "/admin/projects/create",
  "/admin/invoices/create",
  "/admin/estimates/create",
  "/admin/proposals/create",
  "/admin/credit-notes/create",
  "/admin/subscriptions/create",
  "/admin/expenses/create",
  "/admin/support/create",
  "/admin/goals/new",
  "/admin/announcements/new",
  "/admin/setup/staff/new",
];

// Escapes user-supplied text before it goes into a Mongo $regex filter.
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Same tenant-scoping rule every other controller uses (client_controller,
// task_controller, invoice_controller, ticket_controller) — non-superadmin
// staff only ever see their own tenant's records.
const tenantFilter = (req) =>
  !req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};

const tools = [
  {
    name: "navigate_to",
    description:
      "Navigate the CRM to a specific module/page. Use this when the user asks to open, go to, show, or view a section such as tasks, invoices, customers, tickets, etc.",
    input_schema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          enum: NAVIGABLE_ROUTES.map((r) => r.route),
          description: "The CRM route to navigate to",
        },
      },
      required: ["route"],
    },
  },
  {
    name: "search_records",
    description:
      "Search any CRM module's records by name/title. Use this whenever the user asks to find, look up, check on, or list records from a module (customers, leads, tasks, invoices, tickets, purchases, staff, projects, expenses, etc). Returns up to 10 matches with their _id and key fields — use the returned _id for a follow-up update_record or delete_record call instead of re-resolving by name.",
    input_schema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: MODULES.map((m) => m.key),
          description: "Which module to search. Modules: " + MODULES.map((m) => `${m.key} (${m.label})`).join(", "),
        },
        query: { type: "string", description: "Name, title, or partial text to search for" },
      },
      required: ["module", "query"],
    },
  },
  {
    name: "create_record",
    description:
      "Create a new record in a simple CRM module (one that doesn't need linked line items, e.g. lead, customer, task, expense, meeting, staff, ticket, project). For modules with line items or multi-step forms (invoice, estimate, proposal, credit note, quotation, purchase, subscription, contract), prefer open_create_form instead unless the user has given every required detail explicitly. Field names should match what search_records returns for that module (e.g. lead uses 'name'/'company'/'email'/'phonenumber'; expense uses 'expense_name'/'category'/'amount'/'date'; client uses 'company'/'email'/'phonenumber'/'city'/'country').",
    input_schema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: MODULES.map((m) => m.key),
          description: "Which module to create a record in",
        },
        fields: {
          type: "object",
          description: "Key/value pairs of the new record's fields, using the module's actual field names",
        },
      },
      required: ["module", "fields"],
    },
  },
  {
    name: "update_record",
    description:
      "Edit an existing record's fields. Identify the record either by its exact id (preferred, e.g. one returned by a prior search_records call) or by name (a regex search on the module's name field(s) — if more than one record matches, no update happens and the matches are returned so you can ask the user which one they mean).",
    input_schema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: MODULES.map((m) => m.key),
          description: "Which module the record belongs to",
        },
        id: { type: "string", description: "The record's exact _id, if already known" },
        name: { type: "string", description: "Name/title to look the record up by, if id is not known" },
        fields: {
          type: "object",
          description: "Key/value pairs of the fields to change, using the module's actual field names",
        },
      },
      required: ["module", "fields"],
    },
  },
  {
    name: "delete_record",
    description:
      "Delete a record. Requires the EXACT record id (never a name/title) — if you don't have it yet, call search_records first to find it and show it to the user. SAFETY RULE: deletion needs TWO separate human confirmations, one per call, never both assumed from a single reply. " +
      "Call 1: module + id only, no confirm flags — resolves and describes the record, does NOT delete. " +
      "Call 2 (only after the user's first explicit yes): same module + id, confirm: true — this still does NOT delete, it asks for a second, final confirmation. " +
      "Call 3 (only after the user's second explicit yes): same module + id, confirm: true AND confirm_final: true — this actually deletes. Never set confirm_final on the same call as the user's first confirmation.",
    input_schema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: MODULES.map((m) => m.key),
          description: "Which module the record belongs to",
        },
        id: { type: "string", description: "The record's exact _id — required for every call, this tool does not accept a name" },
        confirm: { type: "boolean", description: "Set true starting on the second call, after the human's first explicit confirmation" },
        confirm_final: { type: "boolean", description: "Set true only on the third call, after the human's second, final explicit confirmation" },
      },
      required: ["module", "id"],
    },
  },
  {
    name: "verify_record",
    description:
      "Verify a record exists and is complete/valid. Checks it against the module's required schema fields and flags anything missing or blank. Use when the user asks to check on, verify, or validate a record (e.g. 'is invoice #1042 complete?', 'check lead John Doe'). Read-only — never modifies anything, no confirmation needed.",
    input_schema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          enum: MODULES.map((m) => m.key),
          description: "Which module the record belongs to",
        },
        id: { type: "string", description: "The record's exact _id, if already known" },
        name: { type: "string", description: "Name/title to look the record up by, if id is not known" },
      },
      required: ["module"],
    },
  },
  {
    name: "open_create_form",
    description:
      "Open a module's create form so the user can fill in the details themselves. Prefer this over create_record for records that need linked data the user must pick (invoices, projects, estimates, proposals, credit notes, subscriptions, contracts, purchases, quotations) unless every field was already given explicitly.",
    input_schema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          enum: CREATE_FORM_ROUTES,
          description: "The create-form route to open",
        },
      },
      required: ["route"],
    },
  },
  {
    name: "get_analytics",
    description:
      "Get business numbers for the user's own company: revenue received (sum of payments), total invoiced amount, outstanding/unpaid invoice amount, total expenses, or record counts (customers, leads, tasks, invoices, tickets, projects). Use for questions like 'what's my revenue this month?', 'how much did we spend?', 'how many open leads do I have?'.",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["revenue", "invoiced", "outstanding", "expenses", "ad_spend", "counts"],
          description: "Which number to compute",
        },
        period: {
          type: "string",
          enum: ["this_month", "last_month", "this_year", "all_time"],
          description: "Time period (defaults to this_month; counts ignore the period)",
        },
      },
      required: ["metric"],
    },
  },
];

// Builds the system prompt per-request so it can carry today's date and the
// authenticated user's name/role (Staff doc — see middleware/auth.js protect()).
const buildSystemPrompt = (req, agentName = "CRM Agent") => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const userName = [req.user?.firstname, req.user?.lastname].filter(Boolean).join(" ") || "User";
  const userRole = req.user?.is_superadmin ? "Super Admin" : req.user?.admin ? "Admin" : "Staff";

  return (
    `You are ${agentName}, the assistant built into this CRM. TODAY'S DATE: ${todayStr}. CURRENT USER: ${userName}, role ${userRole}. ` +
    "Help the user navigate the CRM (including Setup pages); search, verify, create, edit, and delete records across every module with search_records/verify_record/create_record/update_record/delete_record; and answer business questions (revenue, expenses, outstanding invoices, record counts) with the get_analytics tool. " +
    "Modules covered: " + MODULES.map((m) => m.label).join(", ") + ". " +
    "Read-only modules (search_records/verify_record only — never attempt create_record/update_record/delete_record on these, and tell the user why if they ask): " +
      MODULES.filter((m) => m.readOnly).map((m) => m.label).join(", ") + ". " +
    "Creating: use create_record for simple standalone modules when the user gives the details; use open_create_form for records with linked line items (invoice, estimate, proposal, credit note, quotation, purchase, subscription, contract) unless every field was already given. Meetings are scheduled entirely inside this CRM — never suggest or mention Google Meet, Zoom, or any other third-party video tool. " +
    "Verifying: call verify_record with the module and the record's id or name to check it exists and has no missing required fields. Read-only, no confirmation needed. Report the result plainly, e.g. 'Record #4521 in Invoices: found and valid' or 'Record #4521 in Invoices: missing client, total'. " +
    "Editing: call update_record with the module, the record's id or name, and the fields to change. If update_record reports multiple matches, list them for the user and ask which one before retrying with the exact id. " +
    "Deleting: delete_record needs the EXACT record id, never a name — if you don't have it, call search_records or verify_record first to find it and show it to the user. Deletion needs TWO separate explicit confirmations from the user, each in its own reply — never assume both from one message. " +
    "Step 1: call delete_record with module+id only — this resolves and describes the record, it does not delete. " +
    "Step 2: after the user's first explicit yes, call delete_record again with the same id and confirm: true — this still does not delete, it asks for a second, final confirmation. " +
    "Step 3: only after the user's second explicit yes, call delete_record with the same id, confirm: true, and confirm_final: true — this deletes it. If multiple records match a name, list them and ask the user to pick one (getting the exact id) before starting the delete flow. " +
    "After any view/verify/create/update/delete action, state which module you checked, what action was performed, and the clear result (e.g. found/valid, missing fields, created, updated, deleted). If an action fails, say why (not found, permission denied, etc). " +
    "Only call a tool when the user's message actually asks for that action. Keep replies brief — one or two sentences unless reporting a verify/delete result that needs the detail above. Format money amounts with thousands separators. " +
    "\n\nLANGUAGE: Users write in Hindi (Devanagari), Roman Hindi, Gujarati (Gujarati script), Roman Gujarati, English, or a mix — understand all of these. Reply in the same language and the same script the user wrote in. Gujarati and Hindi share a lot of vocabulary but use different scripts (Gujarati: ગુજરાતી, Hindi: हिन्दी) — when a word could be either (common with Roman-script input), use the rest of the sentence to tell which language the user is actually writing, don't guess from a single word alone. Keep business words in English even inside a Hindi or Gujarati reply: payment, invoice, project, site, deal, status, pending, follow-up, quotation, GST, approval — never translate these (don't write things like 'भुगतान लंबित' or its Gujarati equivalent, nobody talks that way). Always use the respectful register — आप not तू/तुम in Hindi, તમે not તું in Gujarati. " +
    "NAMES: the CRM stores names in English letters, so Devanagari/Gujarati-script input won't match directly — transliterate before calling search_records/update_record/delete_record (e.g. Hindi 'शर्मा कंस्ट्रक्शन' -> 'Sharma Construction'; Gujarati 'શર્મા કન્સ્ટ્રક્શન' -> 'Sharma Construction'). Strip honorifics before searching: जी/જી/ji, साहब/સાહેબ/sir, भाई/ભાઈ/bhai (e.g. 'शर्मा जी' or 'શર્મા જી' -> 'Sharma'). If nothing matches, retry with common spelling variants (Sharma/Sarma, Agarwal/Agrawal, Gupta/Gupt, Mehta/Mehata, Patel/Patell) before telling the user it wasn't found. " +
    "NUMBERS: लाख/લાખ = 100,000, करोड़/કરોડ = 10,000,000, डेढ़/દોઢ = 1.5x, ढाई/અઢી = 2.5x, सवा/સવા = 1.25x, साढ़े तीन/સાડા ત્રણ = 3.5x (pattern applies to any साढ़े/સાડા + number). Convert these to plain digits before using them in create_record/update_record fields or get_analytics. When speaking an amount back to the user, use the Indian style ('ढाई लाख'/'અઢી લાખ' / grouped as 45,00,000), not the Western word form. " +
    "DATES: कल means yesterday OR tomorrow — decide from the verb tense ('कल भेजा था' = yesterday, sent already; 'कल भेजूंगा' = tomorrow, will send). परसों follows the same rule two days out. If the tense is genuinely ambiguous, ask instead of guessing. Always resolve relative dates to an actual date using TODAY'S DATE above before using them in a tool call. " +
    "DATA RULES: answer only from what the CRM tools return — never outside/general knowledge. Never invent a name, amount, date, stage, or status. An empty field means 'not recorded' — say that, don't fill it in. If a tool finds nothing, say so plainly. If multiple records match, list them and ask the user which one — never pick for them. You are read-only outside the explicit create/update/delete tool flows above — for anything not covered by a tool, only ever suggest a change, never claim you made one. " +
    "STYLE: keep answers to 1-3 sentences unless the user asks for more detail. Name the record you used, e.g. '— Invoice INV-2291'. If the question isn't about CRM data, say so politely and stop. " +
    `Never mention Gemini, Google, Claude, Anthropic, or any AI provider name; you are ${agentName}.`
  );
};

// Resolve a period keyword to a {start, end} date range (null = no bound).
const periodRange = (period) => {
  const now = new Date();
  switch (period) {
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end };
    }
    case "this_year":
      return { start: new Date(now.getFullYear(), 0, 1), end: null };
    case "all_time":
      return { start: null, end: null };
    case "this_month":
    default:
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
  }
};

const dateFilter = (field, { start, end }) => {
  if (!start && !end) return {};
  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lt = end;
  return { [field]: range };
};

// Resolves a single record for update_record/delete_record from either an
// exact id or a name/title search. Never mutates anything itself — callers
// decide what to do with a "found exactly one" result.
const resolveRecord = async (mod, baseFilter, input) => {
  if (input.id) {
    const doc = await mod.Model.findOne({ ...baseFilter, _id: input.id }).lean();
    return doc ? { status: "one", doc } : { status: "none" };
  }
  if (!input.name) return { status: "none" };
  const q = escapeRegex(input.name);
  const filter = { ...baseFilter, $or: mod.nameFields.map((f) => ({ [f]: { $regex: q, $options: "i" } })) };
  const selectFields = Array.from(new Set([...mod.displayFields, "_id"])).join(" ");
  const matches = await mod.Model.find(filter).select(selectFields).limit(6).lean();
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) return { status: "multiple", matches };
  return { status: "one", doc: matches[0] };
};

// Executes one or more Claude tool calls and returns their results as
// tool_result blocks, plus any navigation the frontend should perform.
const runTools = async (contentBlocks, req, agentName = "CRM Agent") => {
  let navigateTo = null;
  const toolResults = [];

  for (const block of contentBlocks) {
    if (block.type !== "tool_use") continue;

    try {
      if (block.name === "navigate_to") {
        navigateTo = block.input.route;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Navigated to ${block.input.route}`,
        });
      } else if (block.name === "search_records") {
        const mod = registry[block.input.module];
        if (!mod) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown module: ${block.input.module}`, is_error: true });
        } else {
          const q = escapeRegex(block.input.query);
          const filter = {
            ...(mod.tenantScoped ? tenantFilter(req) : {}),
            $or: mod.nameFields.map((f) => ({ [f]: { $regex: q, $options: "i" } })),
          };
          const selectFields = Array.from(new Set([...mod.displayFields, "_id"])).join(" ");
          const matches = await mod.Model.find(filter).select(selectFields).limit(10).lean();
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: matches.length ? JSON.stringify(matches) : `No matching ${mod.label} records found.`,
          });
        }
      } else if (block.name === "create_record") {
        const mod = registry[block.input.module];
        if (!mod) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown module: ${block.input.module}`, is_error: true });
        } else if (mod.readOnly) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `${mod.label} is read-only for ${agentName} — you can search or verify these records, but not create, edit, or delete them.`, is_error: true });
        } else {
          const doc = { ...(block.input.fields || {}) };
          if (mod.tenantScoped) doc.tenant_id = req.user?.tenant_id;
          const created = await mod.Model.create(doc);
          const label = mod.nameFields.map((f) => created[f]).filter(Boolean).join(" ") || String(created._id);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Created ${mod.label} "${label}" (id: ${created._id}).`,
          });
        }
      } else if (block.name === "update_record") {
        const mod = registry[block.input.module];
        if (!mod) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown module: ${block.input.module}`, is_error: true });
        } else if (mod.readOnly) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `${mod.label} is read-only for ${agentName} — you can search or verify these records, but not create, edit, or delete them.`, is_error: true });
        } else {
          const baseFilter = mod.tenantScoped ? tenantFilter(req) : {};
          const resolved = await resolveRecord(mod, baseFilter, block.input);
          if (resolved.status === "none") {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `No ${mod.label} record found matching "${block.input.name || block.input.id}".`, is_error: true });
          } else if (resolved.status === "multiple") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Multiple ${mod.label} records match — ask the user which one, then call update_record again with the exact id: ${JSON.stringify(resolved.matches)}`,
            });
          } else {
            const updated = await mod.Model.findOneAndUpdate(
              { ...baseFilter, _id: resolved.doc._id },
              { $set: block.input.fields || {} },
              { new: true, runValidators: true }
            ).lean();
            const label = mod.nameFields.map((f) => updated[f]).filter(Boolean).join(" ") || String(updated._id);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Updated ${mod.label} "${label}" (id: ${updated._id}).`,
            });
          }
        }
      } else if (block.name === "delete_record") {
        const mod = registry[block.input.module];
        if (!mod) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown module: ${block.input.module}`, is_error: true });
        } else if (mod.readOnly) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `${mod.label} is read-only for ${agentName} — you can search or verify these records, but not create, edit, or delete them.`, is_error: true });
        } else if (!block.input.id) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `delete_record requires an exact id. Call search_records for module "${block.input.module}" first to find the record's id, show it to the user, then call delete_record with that id.`,
            is_error: true,
          });
        } else {
          const baseFilter = mod.tenantScoped ? tenantFilter(req) : {};
          const resolved = await resolveRecord(mod, baseFilter, { id: block.input.id });
          if (resolved.status === "none") {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `No ${mod.label} record found with id "${block.input.id}".`, is_error: true });
          } else {
            const label = mod.nameFields.map((f) => resolved.doc[f]).filter(Boolean).join(" ") || String(resolved.doc._id);
            if (!block.input.confirm) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Found ${mod.label} "${label}" (id: ${resolved.doc._id}). Not deleted yet — ask the user to confirm deletion. After their first explicit yes, call delete_record again with id "${resolved.doc._id}" and confirm: true (this still won't delete — a second confirmation follows).`,
              });
            } else if (!block.input.confirm_final) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `First confirmation received for ${mod.label} "${label}" (id: ${resolved.doc._id}). This cannot be undone — ask the user for a second, final confirmation. Only after they explicitly confirm again, call delete_record with id "${resolved.doc._id}", confirm: true, and confirm_final: true to actually delete it.`,
              });
            } else {
              await mod.Model.deleteOne({ ...baseFilter, _id: resolved.doc._id });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Deleted ${mod.label} "${label}" (id: ${resolved.doc._id}).`,
              });
            }
          }
        }
      } else if (block.name === "verify_record") {
        const mod = registry[block.input.module];
        if (!mod) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown module: ${block.input.module}`, is_error: true });
        } else {
          const baseFilter = mod.tenantScoped ? tenantFilter(req) : {};
          const resolved = await resolveRecord(mod, baseFilter, block.input);
          if (resolved.status === "none") {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `No ${mod.label} record found matching "${block.input.name || block.input.id}". Verification result: does not exist.`, is_error: true });
          } else if (resolved.status === "multiple") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Multiple ${mod.label} records match — ask the user which one before verifying: ${JSON.stringify(resolved.matches)}`,
            });
          } else {
            const requiredPaths = mod.Model.schema.requiredPaths().filter((p) => p !== "_id");
            const missing = requiredPaths.filter((p) => {
              const value = resolved.doc[p];
              return value === undefined || value === null || value === "";
            });
            const label = mod.nameFields.map((f) => resolved.doc[f]).filter(Boolean).join(" ") || String(resolved.doc._id);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                module: mod.label,
                id: resolved.doc._id,
                label,
                valid: missing.length === 0,
                missing_fields: missing,
                record: resolved.doc,
              }),
            });
          }
        }
      } else if (block.name === "open_create_form") {
        if (CREATE_FORM_ROUTES.includes(block.input.route)) {
          navigateTo = block.input.route;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Opened the create form at ${block.input.route}. Tell the user the form is open and they can fill in the details.`,
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown create form route: ${block.input.route}`,
            is_error: true,
          });
        }
      } else if (block.name === "get_analytics") {
        const range = periodRange(block.input.period);
        const scope = tenantFilter(req);
        const metric = block.input.metric;
        let content;

        if (metric === "revenue") {
          const rows = await Payment.aggregate([
            { $match: { ...scope, ...dateFilter("date", range) } },
            { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
          ]);
          content = JSON.stringify({ metric, period: block.input.period || "this_month", total_received: rows[0]?.total || 0, payments: rows[0]?.count || 0 });
        } else if (metric === "invoiced") {
          const rows = await Invoice.aggregate([
            { $match: { ...scope, ...dateFilter("date", range), status: { $nin: ["draft", "cancelled"] } } },
            { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
          ]);
          content = JSON.stringify({ metric, period: block.input.period || "this_month", total_invoiced: rows[0]?.total || 0, invoices: rows[0]?.count || 0 });
        } else if (metric === "outstanding") {
          const rows = await Invoice.aggregate([
            { $match: { ...scope, ...dateFilter("date", range), status: { $in: ["unpaid", "partially_paid", "overdue"] } } },
            { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
          ]);
          content = JSON.stringify({ metric, period: block.input.period || "this_month", total_outstanding: rows[0]?.total || 0, invoices: rows[0]?.count || 0 });
        } else if (metric === "expenses") {
          const rows = await Expense.aggregate([
            { $match: { ...scope, ...dateFilter("date", range) } },
            { $group: { _id: null, total: { $sum: { $add: ["$amount", { $ifNull: ["$tax", 0] }] } }, count: { $sum: 1 } } },
          ]);
          content = JSON.stringify({ metric, period: block.input.period || "this_month", total_expenses: rows[0]?.total || 0, entries: rows[0]?.count || 0 });
        } else if (metric === "ad_spend") {
          const MarketingSpend = require("../models/MarketingSpend");
          const [spendRows, leadCount, topSources] = await Promise.all([
            MarketingSpend.aggregate([
              { $match: { ...scope, ...dateFilter("date", range) } },
              { $group: { _id: null, total_spend: { $sum: "$amount" }, entries: { $sum: 1 } } },
            ]),
            Lead.countDocuments({ ...scope, ...dateFilter("createdAt", range) }),
            MarketingSpend.aggregate([
              { $match: { ...scope, ...dateFilter("date", range) } },
              { $group: { _id: { $ifNull: ["$source_name", "General"] }, total: { $sum: "$amount" } } },
              { $sort: { total: -1 } },
              { $limit: 5 },
            ]),
          ]);
          const totalSpend = spendRows[0]?.total_spend || 0;
          const cpl = leadCount > 0 && totalSpend > 0 ? Math.round((totalSpend / leadCount) * 100) / 100 : 0;
          content = JSON.stringify({
            metric: "ad_spend",
            period: block.input.period || "this_month",
            total_ad_spend: totalSpend,
            leads_generated: leadCount,
            cost_per_lead: cpl,
            top_sources: topSources.map((s) => ({ source: s._id || "General", spend: s.total })),
            entries: spendRows[0]?.entries || 0,
          });
        } else {
          const [customers, leads, tasks, invoices, tickets, projects] = await Promise.all([
            Client.countDocuments(scope),
            Lead.countDocuments(scope),
            Task.countDocuments(scope),
            Invoice.countDocuments(scope),
            Ticket.countDocuments(scope),
            Project.countDocuments(scope),
          ]);
          content = JSON.stringify({ metric: "counts", customers, leads, tasks, invoices, tickets, projects });
        }

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        });
      }
    } catch (error) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Tool "${block.name}" failed: ${error.message}`,
        is_error: true,
      });
    }
  }

  return { navigateTo, toolResults };
};

// Keep the Claude context bounded without breaking the protocol: the array
// must start with a plain user message (never an orphaned tool_result).
const MAX_CLAUDE_HISTORY = 30;
const trimClaudeHistory = (msgs) => {
  let trimmed = msgs.slice(-MAX_CLAUDE_HISTORY);
  while (
    trimmed.length &&
    !(trimmed[0].role === "user" && typeof trimmed[0].content === "string")
  ) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
};

const MAX_DISPLAY = 100;

// ── Phase 8: hardening ───────────────────────────────────────────────────
// Limits are DYNAMIC: read from the per-tenant Settings system (same store
// as Setup → Settings), so each admin's tenant can override the global
// defaults, and new tenants automatically inherit them.
const LIMIT_DEFAULTS = { aiRateLimitPerMin: 10, aiDailyRequestLimit: 200 };
const MAX_MESSAGE_CHARS = 2000;

const getLimit = async (name, tenantId) => {
  const [tenantSetting, globalSetting] = await Promise.all([
    tenantId ? Setting.findOne({ name, tenant_id: tenantId }).lean() : null,
    Setting.findOne({ name, tenant_id: null }).lean(),
  ]);
  const raw = tenantSetting?.value ?? globalSetting?.value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LIMIT_DEFAULTS[name];
};

// Resolves dynamic AI Agent name configured by the tenant (default: "CRM Agent")
const getAiAgentName = async (tenantId) => {
  const [tenantSetting, globalSetting] = await Promise.all([
    tenantId ? Setting.findOne({ name: "aiAgentName", tenant_id: tenantId }).lean() : null,
    Setting.findOne({ name: "aiAgentName", tenant_id: null }).lean(),
  ]);
  const val = tenantSetting?.value || globalSetting?.value;
  return typeof val === "string" && val.trim() ? val.trim() : "CRM Agent";
};

// Sliding-window per-minute limiter (in-memory, per user).
const recentRequests = new Map(); // user_id -> [timestamps]
const checkPerMinute = (userId, limit) => {
  const now = Date.now();
  const windowStart = now - 60_000;
  const stamps = (recentRequests.get(userId) || []).filter((t) => t > windowStart);
  if (stamps.length >= limit) return false;
  stamps.push(now);
  recentRequests.set(userId, stamps);
  return true;
};

const today = () => new Date().toISOString().slice(0, 10);

const chat = async (req, res) => {
  // CRM Agent Logs: one row per AI request, written here because only the
  // server knows the real outcome (e.g. the provider's "credit balance too
  // low", which the user only sees as a generic message).
  const logMeta = req.body?.log || {};
  const logAi = (event, extra) =>
    writeVoiceLogs(req, [{
      event,
      source: logMeta.source,
      page: logMeta.page,
      browser: logMeta.browser,
      session_id: logMeta.session_id,
      heard: req.body?.message,
      ...extra,
    }]);

  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ message: "message is required" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ message: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` });
    }

    // Phase 8 — dynamic rate limits & dynamic AI name (per-tenant settings with global fallback)
    const userId = req.user._id.toString();
    const [agentName, perMinLimit, dailyLimit] = await Promise.all([
      getAiAgentName(req.user.tenant_id),
      getLimit("aiRateLimitPerMin", req.user.tenant_id),
      getLimit("aiDailyRequestLimit", req.user.tenant_id),
    ]);
    if (!checkPerMinute(userId, perMinLimit)) {
      logAi("ai_error", { detail: "Rate limited (per-minute limit reached)" });
      return res.status(429).json({ message: `${agentName} is rate limited — please wait a minute and try again.` });
    }
    const usage = await AssistantUsage.findOneAndUpdate(
      { user_id: req.user._id, day: today() },
      { $setOnInsert: { tenant_id: req.user.tenant_id || null } },
      { upsert: true, new: true }
    );
    if (usage.requests >= dailyLimit) {
      logAi("ai_error", { detail: "Daily limit reached" });
      return res.status(429).json({ message: `Daily ${agentName} limit reached. Try again tomorrow or ask your administrator to raise the limit.` });
    }

    // Phase 6: history lives server-side, keyed by the authenticated user —
    // every admin (new or existing) automatically gets their own thread.
    // A client-supplied history is still honored for backward compatibility.
    let chatDoc = null;
    let messages;
    if (Array.isArray(history) && history.length) {
      messages = [...history];
    } else {
      chatDoc = await AssistantChat.findOne({ user_id: req.user._id });
      if (!chatDoc) {
        chatDoc = new AssistantChat({
          user_id: req.user._id,
          tenant_id: req.user.tenant_id || null,
        });
      }
      messages = trimClaudeHistory(chatDoc.claude_history || []);
    }
    messages.push({ role: "user", content: message });

    let inputTokens = 0;
    let outputTokens = 0;
    const trackUsage = (r) => {
      inputTokens += r.usage?.input_tokens || 0;
      outputTokens += r.usage?.output_tokens || 0;
    };

    const systemPrompt = buildSystemPrompt(req, agentName);

    let response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });
    trackUsage(response);

    let navigateTo = null;

    while (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const result = await runTools(response.content, req, agentName);
      if (result.navigateTo) navigateTo = result.navigateTo;
      messages.push({ role: "user", content: result.toolResults });

      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages,
      });
      trackUsage(response);
    }

    messages.push({ role: "assistant", content: response.content });
    const reply = response.content.find((b) => b.type === "text")?.text || "";

    // Persist both the raw Claude context and the human-readable transcript.
    if (chatDoc) {
      chatDoc.claude_history = trimClaudeHistory(messages);
      chatDoc.display.push({ role: "user", text: message });
      if (reply) chatDoc.display.push({ role: "assistant", text: reply });
      if (chatDoc.display.length > MAX_DISPLAY) {
        chatDoc.display = chatDoc.display.slice(-MAX_DISPLAY);
      }
      await chatDoc.save();
    }

    // Phase 8 — record this request against today's usage
    await AssistantUsage.updateOne(
      { user_id: req.user._id, day: today() },
      { $inc: { requests: 1, input_tokens: inputTokens, output_tokens: outputTokens } }
    );

    logAi("ai_reply", { result: navigateTo ? `${reply} [opened ${navigateTo}]` : reply });
    res.json({ reply, navigateTo, history: messages });
  } catch (error) {
    console.error("CRM Agent assistant error:", error);
    // Log the provider's real message (credit, invalid key, model, overload…)
    logAi("ai_error", {
      detail: error?.error?.error?.message || error?.message || "Unknown error",
    });
    // AIProviderError covers any failure from the AI provider (rate limit,
    // invalid key, quota, overload, etc.) — never surface that raw provider
    // error to the client, just a generic message.
    if (error instanceof AIProviderError) {
      return res.status(503).json({ message: "AI service temporarily unavailable. Please try again later." });
    }
    res.status(500).json({ message: "Assistant request failed: " + error.message });
  }
};

// GET /api/assistant/history — this user's saved chat transcript
const getHistory = async (req, res) => {
  try {
    const chatDoc = await AssistantChat.findOne({ user_id: req.user._id })
      .select("display")
      .lean();
    res.json({ messages: chatDoc?.display || [] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/assistant/history — clear this user's conversation
const clearHistory = async (req, res) => {
  try {
    await AssistantChat.deleteOne({ user_id: req.user._id });
    res.json({ message: "Conversation cleared" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/assistant/usage — today's usage + active limits for this user
const getUsage = async (req, res) => {
  try {
    const [usage, perMinLimit, dailyLimit] = await Promise.all([
      AssistantUsage.findOne({ user_id: req.user._id, day: today() }).lean(),
      getLimit("aiRateLimitPerMin", req.user.tenant_id),
      getLimit("aiDailyRequestLimit", req.user.tenant_id),
    ]);
    res.json({
      day: today(),
      requests: usage?.requests || 0,
      input_tokens: usage?.input_tokens || 0,
      output_tokens: usage?.output_tokens || 0,
      limits: { per_minute: perMinLimit, per_day: dailyLimit },
      remaining_today: Math.max(0, dailyLimit - (usage?.requests || 0)),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  chat,
  getHistory,
  clearHistory,
  getUsage,
  // Exported so other controllers (e.g. meeting_controller's live Scribe) can
  // reuse the same CRM tool set and AI client instead of duplicating them.
  tools,
  runTools,
  client,
  MODEL,
  getAiAgentName,
};
