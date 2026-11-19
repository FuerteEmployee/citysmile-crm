const Setting = require("../models/Setting");
const Invoice = require("../models/Invoice");

// Setup > Settings > Finance (General + Invoices) as the backend uses them:
// invoice numbering, default due date, delete rules, staff visibility.

const DEFAULTS = {
  invPrefix: "INV-",
  invNextNumber: 1,
  invNumberFormat: "number_based",
  numberPadding: 0,
  invDueAfter: 30,
  invDeleteOnlyLast: false,
  invDecrementOnDelete: false,
  invAllowStaffView: false,
  invClientNote: "",
  invTerms: "",
};

const isOn = (v) => v === true || v === 1 || v === "1" || v === "true";

/** The company's invoice settings (own row first, then the global default, then DEFAULTS). */
const getInvoiceSettings = async (tenantId) => {
  const names = Object.keys(DEFAULTS);
  const rows = await Setting.find({ name: { $in: names }, $or: [{ tenant_id: tenantId || null }, { tenant_id: null }] }).lean();
  const value = (name) => {
    const own = tenantId ? rows.find((r) => r.name === name && String(r.tenant_id) === String(tenantId)) : null;
    const global = rows.find((r) => r.name === name && r.tenant_id == null);
    const v = (own ?? global)?.value;
    return v === undefined || v === null || v === "" ? DEFAULTS[name] : v;
  };
  const num = (name, min) => {
    const n = parseInt(value(name), 10);
    return Number.isFinite(n) && n >= min ? n : DEFAULTS[name];
  };
  return {
    prefix: String(value("invPrefix") ?? ""),
    nextNumber: num("invNextNumber", 1),
    format: String(value("invNumberFormat") || "number_based"),
    padding: Math.min(num("numberPadding", 0), 12),
    dueAfter: num("invDueAfter", 0),
    deleteOnlyLast: isOn(value("invDeleteOnlyLast")),
    decrementOnDelete: isOn(value("invDecrementOnDelete")),
    allowStaffView: isOn(value("invAllowStaffView")),
    clientNote: String(value("invClientNote") || ""),
    terms: String(value("invTerms") || ""),
  };
};

/** INV-000001 / INV-2026/000001 / INV-000001-26 / INV-000001/10/2026 */
const formatInvoiceNumber = (n, date, cfg) => {
  const d = date ? new Date(date) : new Date();
  const when = isNaN(d.getTime()) ? new Date() : d;
  const seq = String(n).padStart(cfg.padding || 0, "0");
  const yyyy = String(when.getFullYear());
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  switch (cfg.format) {
    case "year_based":
      return `${cfg.prefix}${yyyy}/${seq}`;
    case "000001-yy":
      return `${cfg.prefix}${seq}-${yyyy.slice(-2)}`;
    case "000001/mm/yyyy":
      return `${cfg.prefix}${seq}/${mm}/${yyyy}`;
    default:
      return `${cfg.prefix}${seq}`;
  }
};

const setNextNumber = (tenantId, n) =>
  Setting.findOneAndUpdate({ name: "invNextNumber", tenant_id: tenantId || null }, { value: String(n) }, { upsert: true });

/** Next free number for the company (skips numbers already used), without reserving it. */
const previewNextInvoiceNumber = async (tenantId, date) => {
  const cfg = await getInvoiceSettings(tenantId);
  let n = cfg.nextNumber;
  for (let i = 0; i < 1000; i++, n++) {
    const number = formatInvoiceNumber(n, date, cfg);
    if (!(await Invoice.exists({ tenant_id: tenantId || null, number }))) return { number, n, cfg };
  }
  return { number: formatInvoiceNumber(n, date, cfg), n, cfg };
};

/**
 * Creates an invoice with the company's next number. `create(number)` must
 * insert the invoice; a clash with a number taken in the meantime (unique
 * index per company) is retried with the following number.
 */
const createWithNextNumber = async (tenantId, date, create) => {
  let { n, cfg } = await previewNextInvoiceNumber(tenantId, date);
  for (let attempt = 0; attempt < 20; attempt++, n++) {
    const number = formatInvoiceNumber(n, date, cfg);
    try {
      const doc = await create(number);
      await setNextNumber(tenantId, n + 1);
      return doc;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error("Could not find a free invoice number — check Setup > Settings > Invoices.");
};

/** "Decrement invoice number on delete": give the number back when the newest numbered invoice is deleted. */
const releaseNumberOnDelete = async (tenantId, invoice) => {
  const cfg = await getInvoiceSettings(tenantId);
  if (!cfg.decrementOnDelete || cfg.nextNumber <= 1) return;
  if (invoice.number === formatInvoiceNumber(cfg.nextNumber - 1, invoice.date, cfg)) {
    await setNextNumber(tenantId, cfg.nextNumber - 1);
  }
};

/** Invoice numbers used to be unique across ALL companies; make them unique per company. */
const ensureInvoiceNumberIndex = async () => {
  try {
    const indexes = await Invoice.collection.indexes();
    if (indexes.some((i) => i.name === "number_1" && i.unique)) {
      await Invoice.collection.dropIndex("number_1");
      console.log("[invoices] dropped global unique index number_1 (numbers are now unique per company)");
    }
    await Invoice.collection.createIndex({ tenant_id: 1, number: 1 }, { unique: true, name: "tenant_id_1_number_1" });
  } catch (err) {
    console.error("[invoices] could not update the invoice number index:", err.message);
  }
};

module.exports = {
  getInvoiceSettings,
  formatInvoiceNumber,
  previewNextInvoiceNumber,
  createWithNextNumber,
  releaseNumberOnDelete,
  ensureInvoiceNumberIndex,
  isOn,
};
