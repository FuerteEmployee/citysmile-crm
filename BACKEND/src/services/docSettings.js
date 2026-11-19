const Setting = require("../models/Setting");
const { formatInvoiceNumber, isOn } = require("./invoiceSettings");

// Setup > Settings > Finance > Estimates / Credit Notes / Proposals as the
// backend uses them: numbering (same formats as invoices), default dates,
// predefined note/terms, delete rules, staff visibility.

const TYPES = {
  estimate: {
    model: () => require("../models/Estimate"),
    label: "estimate",
    settingsPage: "Estimates",
    keys: {
      prefix: "estPrefix", next: "estNextNumber", format: "estNumberFormat", dueAfter: "estDueAfter",
      deleteOnlyLast: "estDeleteOnlyLast", decrementOnDelete: "estDecrementOnDelete",
      allowStaffView: "estAllowStaffView", clientNote: "estClientNote", terms: "estTerms",
    },
    defaults: { prefix: "EST-", dueAfter: 7 },
  },
  credit_note: {
    model: () => require("../models/CreditNote"),
    label: "credit note",
    settingsPage: "Credit Notes",
    keys: {
      prefix: "cnPrefix", next: "cnNextNumber", format: "cnNumberFormat",
      decrementOnDelete: "cnDecrementOnDelete", clientNote: "cnClientNote", terms: "cnTerms",
    },
    defaults: { prefix: "CN-", dueAfter: 0 },
  },
  proposal: {
    model: () => require("../models/Proposal"),
    label: "proposal",
    settingsPage: "Proposals",
    keys: { prefix: "propPrefix", next: "propNextNumber", dueAfter: "propDueAfter", allowStaffView: "propAllowStaffView" },
    defaults: { prefix: "PROP-", dueAfter: 7 },
  },
};

const typeOf = (type) => {
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown document type "${type}"`);
  return t;
};

/** The company's settings for `type` (own row first, then the global default, then the defaults). */
const getDocSettings = async (type, tenantId) => {
  const t = typeOf(type);
  const names = [...Object.values(t.keys), "numberPadding"];
  const rows = await Setting.find({ name: { $in: names }, $or: [{ tenant_id: tenantId || null }, { tenant_id: null }] }).lean();
  const value = (name) => {
    if (!name) return undefined;
    const own = tenantId ? rows.find((r) => r.name === name && String(r.tenant_id) === String(tenantId)) : null;
    const global = rows.find((r) => r.name === name && r.tenant_id == null);
    const v = (own ?? global)?.value;
    return v === undefined || v === null || v === "" ? undefined : v;
  };
  const num = (name, min, fallback) => {
    const n = parseInt(value(name), 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    prefix: String(value(t.keys.prefix) ?? t.defaults.prefix),
    nextNumber: num(t.keys.next, 1, 1),
    format: String(value(t.keys.format) || "number_based"),
    padding: Math.min(num("numberPadding", 0, 0), 12),
    dueAfter: num(t.keys.dueAfter, 0, t.defaults.dueAfter),
    deleteOnlyLast: isOn(value(t.keys.deleteOnlyLast)),
    decrementOnDelete: isOn(value(t.keys.decrementOnDelete)),
    allowStaffView: isOn(value(t.keys.allowStaffView)),
    clientNote: String(value(t.keys.clientNote) || ""),
    terms: String(value(t.keys.terms) || ""),
  };
};

const setNextNumber = (type, tenantId, n) =>
  Setting.findOneAndUpdate({ name: typeOf(type).keys.next, tenant_id: tenantId || null }, { value: String(n) }, { upsert: true });

/** Next free number for the company (skips numbers already used), without reserving it. */
const previewNextNumber = async (type, tenantId, date) => {
  const Model = typeOf(type).model();
  const cfg = await getDocSettings(type, tenantId);
  let n = cfg.nextNumber;
  for (let i = 0; i < 1000; i++, n++) {
    const number = formatInvoiceNumber(n, date, cfg);
    if (!(await Model.exists({ tenant_id: tenantId || null, number }))) return { number, n, cfg };
  }
  return { number: formatInvoiceNumber(n, date, cfg), n, cfg };
};

/** Creates the document with the company's next number; `create(number)` inserts it, clashes are retried. */
const createWithNextNumber = async (type, tenantId, date, create) => {
  let { n, cfg } = await previewNextNumber(type, tenantId, date);
  for (let attempt = 0; attempt < 20; attempt++, n++) {
    const number = formatInvoiceNumber(n, date, cfg);
    try {
      const doc = await create(number);
      await setNextNumber(type, tenantId, n + 1);
      return doc;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error(`Could not find a free ${typeOf(type).label} number — check Setup > Settings > ${typeOf(type).settingsPage}.`);
};

/** "Decrement number on delete": give the number back when the newest numbered document is deleted. */
const releaseNumberOnDelete = async (type, tenantId, doc) => {
  const cfg = await getDocSettings(type, tenantId);
  if (!cfg.decrementOnDelete || cfg.nextNumber <= 1) return;
  if (doc.number === formatInvoiceNumber(cfg.nextNumber - 1, doc.date, cfg)) {
    await setNextNumber(type, tenantId, cfg.nextNumber - 1);
  }
};

/** "Delete allowed only on last …": the 400 message when `doc` is not the company's newest one, else null. */
const notLastMessage = async (type, doc) => {
  const t = typeOf(type);
  const cfg = await getDocSettings(type, doc.tenant_id);
  if (!cfg.deleteOnlyLast) return null;
  const last = await t.model().findOne({ tenant_id: doc.tenant_id ?? null }).sort({ createdAt: -1 }).select("_id number");
  if (!last || String(last._id) === String(doc._id)) return null;
  return `Only the most recent ${t.label} (${last.number}) can be deleted — Setup > Settings > ${t.settingsPage} > "Delete ${t.label} allowed only on last ${t.label}".`;
};

/** Numbers used to be unique across ALL companies; make them unique per company. */
const ensureNumberIndexes = async () => {
  for (const type of Object.keys(TYPES)) {
    const Model = TYPES[type].model();
    try {
      const indexes = await Model.collection.indexes();
      if (indexes.some((i) => i.name === "number_1" && i.unique)) {
        await Model.collection.dropIndex("number_1");
        console.log(`[${type}] dropped global unique index number_1 (numbers are now unique per company)`);
      }
      // Old proposals have no number: only enforce it where one is set.
      await Model.collection.createIndex(
        { tenant_id: 1, number: 1 },
        { unique: true, name: "tenant_id_1_number_1", partialFilterExpression: { number: { $type: "string" } } }
      );
    } catch (err) {
      console.error(`[${type}] could not update the number index:`, err.message);
    }
  }
};

/** Tenant filter (+ "own"/"assigned" staff filter) for reading or changing one document. */
const docScope = (req, ownFields = ["created_by"]) => {
  const scope = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) scope.tenant_id = req.user.tenant_id;
  if (req.permissionLevel === "own" || req.permissionLevel === "assigned") {
    const me = req.user._id;
    scope.$or = ownFields.map((f) => ({ [f]: f === "created_by" ? me : String(me) }));
  }
  return scope;
};

/**
 * Wraps checkPermission(module, "View"): staff without it may still OPEN
 * (GET only) the documents assigned to them when the "Allow staff members to
 * view … where they are assigned to" setting of `type` is on.
 */
const viewOrAssigned = (checkPermission, module, type) => (req, res, next) => {
  const fallback = async () => {
    try {
      if (req.method === "GET" && req.userRole === "staff" && (await getDocSettings(type, req.user?.tenant_id)).allowStaffView) {
        req.permissionLevel = "assigned";
        return next();
      }
    } catch { /* fall through to the normal refusal */ }
    res.status(403).json({ message: `Forbidden: no View permission for ${module}` });
  };
  const fakeRes = {
    status: (code) => ({ json: (body) => (code === 403 ? fallback() : res.status(code).json(body)) }),
  };
  checkPermission(module, "View")(req, fakeRes, next);
};

/** Adds `sale_agent_name` / `project_name` for the preview (agent and project are stored as id strings). */
const addDisplayNames = async (obj, agentField) => {
  const mongoose = require("mongoose");
  const isId = (v) => v && mongoose.isValidObjectId(String(v));
  const agentId = agentField ? obj[agentField]?._id || obj[agentField] : null;
  const [agent, project] = await Promise.all([
    isId(agentId) ? require("../models/Staff").findById(agentId).select("firstname lastname").lean() : null,
    isId(obj.project) ? require("../models/Project").findById(obj.project).select("name").lean() : null,
  ]);
  if (agent) obj.sale_agent_name = [agent.firstname, agent.lastname].filter(Boolean).join(" ");
  if (project) obj.project_name = project.name || "";
  return obj;
};

/** GET /<docs>/next-number: next number + the defaults a new document's form pre-fills. */
const nextNumberHandler = (type) => async (req, res) => {
  try {
    const { number, cfg } = await previewNextNumber(type, req.user?.tenant_id, req.query.date);
    res.json({ number, dueAfter: cfg.dueAfter, clientNote: cfg.clientNote, terms: cfg.terms });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const addDays = (date, days) => new Date(new Date(date || Date.now()).getTime() + days * 24 * 60 * 60 * 1000);

module.exports = {
  getDocSettings,
  previewNextNumber,
  createWithNextNumber,
  releaseNumberOnDelete,
  notLastMessage,
  ensureNumberIndexes,
  docScope,
  viewOrAssigned,
  addDisplayNames,
  nextNumberHandler,
  addDays,
};
