// Round 30 (S6): the reference price list — helpers with no HTTP in them.
//   parseCatalogList(input)   → { list } | { error }   (multi-paste: one per
//                               line / comma / semicolon / tab; max 200)
//   entryKeys(entry)          → the lower-case lookup keys of an entry
//   pickEntry(token, entries) → { entry, via, note } | null
//                               (catalog no. → Y code → obsolete catalog / Y)
//   itemFromEntry(entry)      → values for a new PoItem
const MAX_PASTE = 200;
const MAX_TOKEN = 100;
const DEFAULT_GST = 18;

const lower = (s) => String(s ?? "").trim().toLowerCase();

const parseCatalogList = (input) => {
  const raw = Array.isArray(input) ? input.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : "")).join("\n") : typeof input === "string" ? input : "";
  const seen = new Set();
  const list = [];
  for (const part of raw.split(/[\r\n,;\t]+/)) {
    const t = part.trim().replace(/^["']+|["']+$/g, "").trim();
    if (!t) continue;
    if (t.length > MAX_TOKEN) return { error: `"${t.slice(0, 20)}…" is too long for a catalog no. (max ${MAX_TOKEN} characters)` };
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    list.push(t);
  }
  if (!list.length) return { error: "Type a catalog no. (or Y code / obsolete catalog no.)" };
  if (list.length > MAX_PASTE) return { error: `Paste at most ${MAX_PASTE} catalog nos. at a time (${list.length} given)` };
  return { list };
};

const entryKeys = (e) => ({
  code_lc: lower(e.item_code),
  y_lc: lower(e.y_code),
  replaces_lc: (e.replaces || []).map(lower).filter(Boolean),
});

// The best entry for one typed token among the candidates found by the query.
const pickEntry = (token, entries) => {
  const t = lower(token);
  const byCode = entries.find((e) => e.code_lc === t);
  if (byCode) return { entry: byCode, via: "catalog", note: "" };
  const byY = entries.find((e) => e.y_lc === t);
  if (byY) return { entry: byY, via: "y_code", note: `found by Y code ${String(token).toUpperCase()}` };
  const byOld = entries.find((e) => (e.replaces_lc || []).includes(t));
  if (byOld) return { entry: byOld, via: "obsolete", note: `${token} is obsolete — replaced by ${byOld.item_code || byOld.y_code}` };
  return null;
};

// What the dialog / picker shows of an entry.
const publicEntry = (e) => ({
  item_code: e.item_code || "",
  y_code: e.y_code || "",
  description: e.description || "",
  unit: e.unit || "",
  hsn: e.hsn || "",
  tax_rate: e.tax_rate ?? DEFAULT_GST,
  master_price: e.master_price ?? 0,
  distributor_price: e.distributor_price ?? 0,
  end_customer_price: e.end_customer_price ?? 0,
  lead_time: e.lead_time || "",
  category: e.category || "",
  price_sheet: e.price_sheet || "",
  replaces: e.replaces || [],
});

const itemFromEntry = (e) => {
  const attrs = e.attributes instanceof Map ? Object.fromEntries(e.attributes) : e.attributes;
  const out = {
    item_code: e.item_code || undefined,
    y_code: e.y_code || "",
    name: e.item_code || e.y_code,
    description: e.description || "",
    hsn: e.hsn || "",
    unit: e.unit || "Nos",
    tax_rate: e.tax_rate ?? DEFAULT_GST,
    master_price: e.master_price ?? 0,
    distributor_price: e.distributor_price ?? 0,
    end_customer_price: e.end_customer_price ?? 0,
    lead_time: e.lead_time || "",
    remarks: e.remarks || "",
    category: e.category || "",
    price_sheet: e.price_sheet || "",
  };
  if (attrs && Object.keys(attrs).length) out.attributes = attrs;
  if (e.replaces && e.replaces.length) out.replaces = [...e.replaces];
  return out;
};

module.exports = { parseCatalogList, entryKeys, pickEntry, publicEntry, itemFromEntry, lower, MAX_PASTE };
