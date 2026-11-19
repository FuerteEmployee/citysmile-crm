// Purchase Orders round 29 (S4): the field formats, in one place. Pure
// functions, no DB — the controllers call them and turn a returned message
// into a 400; the frontend mirrors them in pages/purchase-orders/poValidation.ts
// with the SAME messages, so the editor shows per field what the API says.
//
// Each validator returns { value } (cleaned) or { error } (the message).
// "Optional" validators accept "" / null / undefined as { value: "" }.

const ok = (value) => ({ value });
const bad = (error) => ({ error });
const isEmpty = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const text = (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : null);

// Catalog no. / item code: 2-40 characters — letters, digits, - / . _ —
// stored as typed (trimmed), compared case-insensitively elsewhere.
const CATALOG_RE = /^[A-Za-z0-9][A-Za-z0-9\-/._]*$/;
const catalogNo = (v, { required = true, label = "Catalog no." } = {}) => {
  if (isEmpty(v)) return required ? bad(`${label} is required`) : ok("");
  const t = text(v);
  if (t === null) return bad(`${label}: enter text`);
  if (t.length < 2 || t.length > 40) return bad(`${label} must be 2 to 40 characters`);
  if (!CATALOG_RE.test(t)) return bad(`${label} can only have letters, digits and - / . _ (no spaces)`);
  return ok(t);
};

// Y code: "Y" + 5 to 9 digits (optional), upper-cased.
const yCode = (v) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || !/^Y\d{5,9}$/i.test(t)) return bad("Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)");
  return ok(t.toUpperCase());
};

// Phone: Indian mobile (10 digits starting 6-9, optional +91 / 91 / 0 in
// front) or a landline with its STD code (starts with 0, or +91), 8-15 digits.
// Digits, spaces and - only (a leading + is fine).
const PHONE_MSG = "Enter a 10-digit mobile (starting 6-9, +91 / 0 allowed) or a landline with STD code";
const phone = (v, { label = "Phone" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || !/^\+?[\d][\d\s-]*$/.test(t)) return bad(`${label}: ${PHONE_MSG}`);
  const d = t.replace(/\D/g, "");
  if (/^(91|0)?[6-9]\d{9}$/.test(d)) return ok(t);
  const plus91 = t.startsWith("+") && d.startsWith("91");
  if ((d.startsWith("0") || plus91) && d.length >= 8 && d.length <= 15) return ok(t);
  return bad(`${label}: ${PHONE_MSG}`);
};

// GSTIN: 15 characters, state code 01-38, upper-cased.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const gstin = (v, { label = "GSTIN" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  const up = t === null ? "" : t.toUpperCase().replace(/\s+/g, "");
  if (!GSTIN_RE.test(up)) return bad(`${label} must be 15 characters like 24ABCDE1234F1Z5`);
  const state = Number(up.slice(0, 2));
  if (state < 1 || state > 38) return bad(`${label}: state code ${up.slice(0, 2)} is not valid (01-38)`);
  return ok(up);
};

// Customer PO No.: 1-60 characters — letters, digits, space - _ . ( ) /
// ("/" too: customer PO numbers like SGE/PO/2026/145 use it).
const customerPoNo = (v, { required = false } = {}) => {
  if (isEmpty(v)) return required ? bad("Customer PO No. is required when the customer's PO file is attached") : ok("");
  const t = text(v);
  if (t === null) return bad("Customer PO No.: enter text");
  if (t.length > 60) return bad("Customer PO No. can't be longer than 60 characters");
  if (!/^[A-Za-z0-9 \-_.()/]+$/.test(t)) return bad("Customer PO No. can only have letters, digits, space and - _ . ( ) /");
  return ok(t);
};

// PO number prefix: 1-10 characters — letters, digits, - (no "/" or space).
const poPrefix = (v, { label = "PO number prefix" } = {}) => {
  if (isEmpty(v)) return bad(`${label} is required`);
  const t = text(v);
  if (t === null || t.length > 10 || !/^[A-Za-z0-9-]+$/.test(t)) return bad(`${label}: 1 to 10 letters, digits or - (no "/" or spaces)`);
  return ok(t);
};

const email = (v, { label = "Email" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || t.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return bad(`${label} is not a valid email address`);
  return ok(t);
};

// HSN / SAC: 4, 6 or 8 digits (optional).
const hsn = (v, { label = "HSN/SAC" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || !/^(\d{4}|\d{6}|\d{8})$/.test(t)) return bad(`${label} must be 4, 6 or 8 digits`);
  return ok(t);
};

// GST %: the usual slabs. Anything else is allowed but pointed out.
const GST_SLABS = [0, 5, 12, 18, 28, 40];
const gstWarning = (rate, label = "GST %") =>
  rate === undefined || rate === null || GST_SLABS.includes(Number(rate)) ? null : `${label} ${rate} is not a usual GST rate (0, 5, 12, 18, 28 or 40)`;

// A typed number: "abc" / "" / Infinity → error. Strings like "12" are fine.
const toNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v.trim());
  return NaN;
};

// Quantity: whole number 1 to 1,00,000.
const MAX_QTY = 100000;
const quantity = (v, { label = "Quantity" } = {}) => {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return bad(`${label}: enter a number`);
  if (n <= 0) return bad(`${label} must be more than 0`);
  if (!Number.isInteger(n)) return bad(`${label} must be a whole number`);
  if (n > MAX_QTY) return bad(`${label} can't be more than 1,00,000`);
  return ok(n);
};

// Price / amount: 0 to 1,00,00,000 with at most 2 decimals.
const MAX_PRICE = 10000000;
const price = (v, { label = "Price", required = true } = {}) => {
  if (isEmpty(v) && !required) return ok(undefined);
  const n = toNumber(v);
  if (!Number.isFinite(n)) return bad(`${label}: enter a number`);
  if (n < 0) return bad(`${label} can't be negative`);
  if (n > MAX_PRICE) return bad(`${label} can't be more than 1,00,00,000`);
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return bad(`${label}: at most 2 decimals`);
  return ok(n);
};

const percent = (v, { label = "Disc %" } = {}) => {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return bad(`${label}: enter a number`);
  if (n < 0 || n > 100) return bad(`${label} must be from 0 to 100`);
  return ok(n);
};

// Proforma "valid for": whole days 1 to 365.
const validDays = (v) => {
  const n = toNumber(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) return bad("Valid for (days) must be a whole number from 1 to 365");
  return ok(n);
};

// Series (price-list sheet) name: trimmed, inner spaces collapsed, 1-40
// characters — letters, digits, space, - and _.
const SERIES_MSG = "Series name: 1 to 40 letters, digits, spaces, - or _";
const seriesName = (v) => {
  const t = text(v);
  const clean = t === null ? "" : t.replace(/\s+/g, " ");
  if (!clean) return bad("Series is required");
  if (clean.length > 40 || !/^[A-Za-z0-9 _-]+$/.test(clean)) return bad(SERIES_MSG);
  return ok(clean);
};
// A sheet name as a series: characters outside the rule become "-" (e.g.
// "PMK&BBP85_30.03.2026" → "PMK-BBP85_30-03-2026"), spaces collapsed.
const seriesFromSheet = (name) =>
  String(name || "")
    .replace(/[^A-Za-z0-9 _-]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .slice(0, 40)
    .trim() || "Series";
// The existing series with the same name (case-insensitive), else the name.
const reuseSeries = (name, existing = []) => existing.find((s) => String(s).toLowerCase() === String(name).toLowerCase()) || name;

// A name (company / supplier / account holder): must have at least one letter
// — "12345" alone is not a name. Digits and normal punctuation are fine
// ("3M India Ltd", "A & B Traders (P) Ltd"); < and > are never allowed.
const personOrCompanyName = (v, { label = "Name", required = false } = {}) => {
  if (isEmpty(v)) return required ? bad(`${label} is required`) : ok("");
  const t = text(v);
  if (t === null || !/[A-Za-z]/.test(t)) return bad(`${label} must have letters, not only numbers or symbols`);
  if (/[<>]/.test(t)) return bad(`${label} can't contain < or >`);
  return ok(t);
};

// State: letters, spaces, & . - only (e.g. "Gujarat", "Jammu & Kashmir").
const stateName = (v, { label = "State" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || t.length > 50 || !/^[A-Za-z][A-Za-z &.-]*$/.test(t)) return bad(`${label} can only have letters, spaces and & . -`);
  return ok(t);
};

// Bank account no.: ONE number, 9 to 18 digits, nothing else.
const bankAccountNo = (v, { label = "Account no." } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || !/^\d+$/.test(t)) return bad(`${label}: digits only — one account number, no spaces, letters or commas`);
  if (t.length < 9 || t.length > 18) return bad(`${label} must be 9 to 18 digits`);
  return ok(t);
};

// IFSC: 4 letters + 0 + 6 letters/digits (e.g. SBIN0001234), upper-cased.
const ifsc = (v, { label = "IFSC" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  const up = t === null ? "" : t.toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(up)) return bad(`${label} must be 11 characters: 4 letters, 0, then 6 letters or digits (e.g. SBIN0001234)`);
  return ok(up);
};

// Logo URL: empty (= the CRM logo), an http(s) link, or a path on this CRM ("/uploads/...").
const logoUrl = (v, { label = "Logo URL" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || /\s/.test(t) || !/^(https?:\/\/[^/\s]+\.[^\s]+|\/[^\s]+)$/i.test(t)) return bad(`${label} must be a link starting with https:// (or empty for the CRM logo)`);
  return ok(t);
};

// Proforma number prefix: optional, up to 20 letters, digits, - _ / (e.g. "TT/PI/").
const proformaPrefix = (v) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || t.length > 20 || !/^[A-Za-z0-9\-_/]+$/.test(t)) return bad("Proforma number prefix: up to 20 letters, digits or - _ / (no spaces)");
  return ok(t);
};

// Minimum margin %: empty = no check, else 0 to 100.
const marginPct = (v, { label = "Minimum margin %" } = {}) => {
  if (isEmpty(v)) return ok(null);
  const n = toNumber(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return bad(`${label} must be from 0 to 100 (empty = no check)`);
  return ok(n);
};

// Unit (UoM): letters needed ("Nos", "Mtr", "Roll"); digits alone are not a unit.
const unitName = (v, { label = "Unit" } = {}) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || t.length > 30 || !/[A-Za-z]/.test(t) || !/^[A-Za-z0-9 .\-/]+$/.test(t)) return bad(`${label} must be letters like Nos, Mtr, Roll (up to 30 characters)`);
  return ok(t);
};

// WhatsApp template (Meta rules): name = lower-case letters, digits, _ ;
// language code like "en" or "en_US".
const waTemplateName = (v) => {
  if (isEmpty(v)) return ok("");
  const t = text(v);
  if (t === null || t.length > 512 || !/^[a-z0-9_]+$/.test(t)) return bad("Template name: lower-case letters, digits and _ only, exactly as approved in Meta (e.g. po_document)");
  return ok(t);
};
const waLanguage = (v) => {
  if (isEmpty(v)) return ok("en");
  const t = text(v);
  if (t === null || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t)) return bad("Language code must look like en or en_US");
  return ok(t);
};

// Dates compared by calendar day (India time — the same day the user sees).
const dayKey = (d) => {
  const t = new Date(d);
  if (isNaN(t.getTime())) return null;
  return new Date(t.getTime() + 330 * 60000).toISOString().slice(0, 10);
};
const poDates = ({ po_date, expected_date, customer_po_date }) => {
  const errors = [];
  const po = po_date ? dayKey(po_date) : dayKey(new Date());
  if (expected_date && po && dayKey(expected_date) < po) errors.push({ field: "expected_date", message: "Expected delivery can't be before the PO date" });
  if (customer_po_date && po && dayKey(customer_po_date) > po) errors.push({ field: "customer_po_date", message: "Customer PO date can't be after the PO date" });
  return errors;
};

module.exports = {
  personOrCompanyName,
  stateName,
  bankAccountNo,
  ifsc,
  logoUrl,
  proformaPrefix,
  marginPct,
  unitName,
  waTemplateName,
  waLanguage,
  catalogNo,
  yCode,
  phone,
  gstin,
  customerPoNo,
  poPrefix,
  email,
  hsn,
  gstWarning,
  GST_SLABS,
  quantity,
  price,
  percent,
  validDays,
  seriesName,
  seriesFromSheet,
  reuseSeries,
  poDates,
  dayKey,
  MAX_QTY,
  MAX_PRICE,
};
