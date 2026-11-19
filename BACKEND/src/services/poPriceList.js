// Brady price-list import (R3) — pure functions, no DB access.
//
// The client's price list (F2) has ~20 sheets, each with its own headers
// ("Catalog No" / "CATALOG NUMBER" / "Catalog", "MDP ( INR / UOM)" /
// "Master Distributor Price (…)", a Y code in a column titled "Material" or
// even "Y958908"…). For every sheet we:
//   1. find the header row (the row with the most recognised column titles),
//   2. map each column to a field by synonyms, then by its contents,
//   3. turn the rows under it into item records (prices rounded to 2 dp),
// and across sheets resolve the same catalog appearing more than once by a
// sheet priority list (first sheet in the list wins; the user may pick per
// item). Nothing here knows the client's company or file — only the header
// styles.
//
// Used by purchase_order_controller (scan / preview / import endpoints).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Fields a column can be mapped to (the mapping step's choices).
const FIELDS = [
  "catalog",
  "y_code",
  "description",
  "hsn",
  "unit",
  "tax_rate",
  "master_price",
  "distributor_price",
  "end_customer_price",
  "lead_time",
  "remarks",
  "obsolete_catalog",
  "obsolete_y_code",
  "attribute",
  "ignore",
];
const FIELD_LABELS = {
  catalog: "Catalog no.",
  y_code: "Y code",
  description: "Description",
  hsn: "HSN",
  unit: "Unit",
  tax_rate: "GST %",
  master_price: "Master Distributor Price",
  distributor_price: "Distributor Price",
  end_customer_price: "End User Price",
  lead_time: "Lead time",
  remarks: "Remarks",
  obsolete_catalog: "Obsolete catalog (replaced)",
  obsolete_y_code: "Obsolete Y code (replaced)",
  attribute: "Extra detail (attribute)",
  ignore: "Ignore",
};
const PRICE_KEYS = ["master_price", "distributor_price", "end_customer_price"];
const SINGLE = FIELDS.filter((f) => f !== "attribute" && f !== "ignore"); // one column each

const normHeader = (h) =>
  String(h ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();

// A column title → field ("attribute" = an extra detail column; null = no title).
const headerField = (raw) => {
  const h = normHeader(raw);
  if (!h) return null;
  if (/^y\d{5,}$/.test(h)) return "y_code"; // a Y number used as the title (BMP71 sheet)
  if (/obsolete/.test(h) && /catalog/.test(h)) return "obsolete_catalog";
  if (/obsolete/.test(h) && /(ynumber|\by ?(number|code|no)\b)/.test(h)) return "obsolete_y_code";
  if (/obsolete|go live|replacement part available/.test(h)) return "attribute";
  if (/\bcatalog/.test(h)) return "catalog";
  if (/(^|\s)y ?(code|number|no)\b|ynumber/.test(h)) return "y_code";
  if (/\bmaster\b|^mdp\b/.test(h)) return "master_price";
  if (/end ?user|end ?customer|^ep\b/.test(h)) return "end_customer_price";
  if (/distributor|^dp\b|^dpuser/.test(h)) return "distributor_price";
  if (/\bhsn\b|\bsac\b/.test(h)) return "hsn";
  if (/^(uo?m|unit|units)$/.test(h)) return "unit";
  if (/description|^desc\b/.test(h)) return "description";
  if (/lead ?ti/.test(h)) return "lead_time";
  if (/remark/.test(h)) return "remarks";
  if (/^(gst|gst %|gst rate|tax rate|tax %)$/.test(h)) return "tax_rate";
  return "attribute";
};

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const cellText = (v) => (isBlank(v) ? "" : String(v).replace(/\s+/g, " ").trim());

const Y_RE = /^Y\d{4,}$/i;
const share = (values, re) => (values.length ? values.filter((v) => re.test(v)).length / values.length : 0);

// Columns' sample values (non-blank, as text) under the header row.
const columnSamples = (rows, headerRow, width, max = 40) => {
  const out = Array.from({ length: width }, () => []);
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < width; c++) {
      if (out[c].length < max && !isBlank(row[c])) out[c].push(cellText(row[c]));
    }
    if (out.every((s) => s.length >= max)) break;
  }
  return out;
};

// Field for every column of `rows[headerRow]`: by title, then by contents.
const autoFields = (rows, headerRow) => {
  const header = rows[headerRow] || [];
  const width = Math.max(header.length, ...rows.slice(headerRow + 1, headerRow + 41).map((r) => (r || []).length), 0);
  const samples = columnSamples(rows, headerRow, width);
  const fields = [];
  const used = new Set();
  for (let c = 0; c < width; c++) {
    let f = headerField(header[c]);
    if (f && SINGLE.includes(f)) {
      if (used.has(f)) f = "attribute"; // a second "CATALOG NUMBER" column
      else used.add(f);
    }
    fields.push(f || "ignore");
  }
  // By contents: a "Material" column full of Y numbers is the Y code (HX
  // sheet); "Lead Time 8-10 Weeks" / "GST Extra…" under "Column1" etc.
  const byContent = [
    ["y_code", Y_RE],
    ["lead_time", /^(lead\s*time\b.*|\d+\s*-\s*\d+\s*(weeks?|months?))$/i],
    ["remarks", /gst\s*extra/i],
  ];
  for (const [field, re] of byContent) {
    if (used.has(field)) continue;
    const c = fields.findIndex((f, i) => (f === "attribute" || f === "ignore") && samples[i].length >= 3 && share(samples[i], re) >= 0.6);
    if (c >= 0) {
      fields[c] = field;
      used.add(field);
    }
  }
  // No catalog column: a description column of codes only (no spaces, e.g.
  // "HX-094-2-WT-SC") is the catalog.
  if (!used.has("catalog")) {
    const c = fields.findIndex((f, i) => f === "description" && samples[i].length >= 3 && share(samples[i], /^(?=.*[\d-])[A-Z0-9][A-Z0-9\-\/.]*$/i) >= 0.6);
    if (c >= 0) fields[c] = "catalog";
  }
  return fields;
};

const hasKey = (fields) => fields.includes("catalog") || fields.includes("y_code");
const hasPrice = (fields) => fields.some((f) => PRICE_KEYS.includes(f));
const knownCount = (fields) => fields.filter((f) => SINGLE.includes(f)).length;

// Why a mapping can't be imported ("" = fine).
const mappingProblem = (fields) => {
  if (!hasKey(fields) && !hasPrice(fields)) return "No catalog, Y code or price columns found — not an item list";
  if (!hasKey(fields)) return "No catalog or Y code column found";
  if (!hasPrice(fields)) return "No price column found";
  return "";
};

// "catalog no|y code|…" — identifies a header layout, so a confirmed mapping
// can be reused on the next upload.
const signatureOf = (headerCells) => {
  const cells = (headerCells || []).map(normHeader);
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return cells.join("|");
};

// The header row: the row (in the first 25) with the most recognised titles;
// the earliest wins a tie. -1 when no row has at least 2.
const findHeaderRow = (rows) => {
  let best = -1;
  let bestScore = 1;
  const limit = Math.min(rows.length, 25);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] || [];
    const fields = row.map(headerField).filter(Boolean);
    const score = knownCount(fields) + (hasKey(fields) ? 1 : 0) + (hasPrice(fields) ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
};

const dataRowCount = (rows, headerRow) => {
  let n = 0;
  for (let r = headerRow + 1; r < rows.length; r++) if ((rows[r] || []).some((v) => !isBlank(v))) n++;
  return n;
};

// Column labels for the mapping step and for attributes.
const columnLabel = (header, c) => cellText(header[c]) || `Column ${c + 1}`;

// Scan one sheet: header row, column → field, rows, why it's skipped.
// `saved` = remembered mappings [{ signature, fields }] (from PO Settings).
const detectSheet = (name, rows, saved = []) => {
  const out = { name, header_row: -1, columns: [], signature: "", remembered: false, item_rows: 0, skip_reason: "" };
  if (!Array.isArray(rows) || rows.every((r) => !(r || []).some((v) => !isBlank(v)))) {
    out.skip_reason = "Empty sheet";
    return out;
  }
  const headerRow = findHeaderRow(rows);
  if (headerRow < 0) {
    out.skip_reason = "No catalog, Y code or price columns found — not an item list";
    return out;
  }
  const header = rows[headerRow] || [];
  const auto = autoFields(rows, headerRow);
  out.header_row = headerRow;
  out.signature = signatureOf(header);
  const remembered = saved.find((m) => m.signature === out.signature);
  const fields = auto.map((f, c) => {
    const s = remembered?.fields?.[c] ?? remembered?.fields?.[String(c)];
    return FIELDS.includes(s) ? s : f;
  });
  out.remembered = !!remembered;
  const samples = columnSamples(rows, headerRow, fields.length, 3);
  out.columns = fields.map((field, c) => ({ index: c, header: columnLabel(header, c), field, auto_field: auto[c], sample: samples[c] }));
  out.item_rows = dataRowCount(rows, headerRow);
  out.skip_reason = mappingProblem(fields) || (out.item_rows === 0 ? "No item rows under the header" : "");
  return out;
};

// A price cell: a number, or text like "1,250" / "₹ 1,250.50". Anything else
// is NaN (an error row). Same as the controller's priceNum.
const priceCell = (v) => {
  if (isBlank(v)) return undefined;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? round2(v) : NaN;
  const cleaned = String(v).trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? round2(Number(cleaned)) : NaN;
};

const gstCell = (v) => {
  if (isBlank(v)) return undefined;
  const n = typeof v === "number" ? (v > 0 && v < 1 ? v * 100 : v) : Number(String(v).trim().replace(/\s*%$/, ""));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? round2(n) : NaN;
};

const NO_VALUE = /^(na|n\/a|nil|none|-+|0|not got)$/i;
const codeText = (v) => {
  const s = cellText(v);
  return NO_VALUE.test(s) ? "" : s.slice(0, 100);
};
const yText = (v) => {
  const s = cellText(v).toUpperCase();
  return Y_RE.test(s) ? s : "";
};

const attrKey = (label) => label.replace(/[.$]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Detail";

// Rows under the header → item records. Blank / section rows (no code and no
// price) are left out; a row with a problem gets `error` (shown, not saved).
const extractRows = (name, rows, headerRow, fields) => {
  const header = rows[headerRow] || [];
  const headerNorm = header.map(normHeader);
  const records = [];
  let blank = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((v) => !isBlank(v))) continue;
    // The header repeated further down the sheet (a new block): not an item.
    // Seen as: at least 2 of the mapped columns hold a title of that same field.
    // (only catalog / price columns count: a Y code or "Lead Time 8-10 Weeks"
    // value also reads like a title.)
    const titled = fields.filter((f, c) => ["catalog", ...PRICE_KEYS].includes(f) && typeof row[c] === "string" && (headerField(row[c]) === f || normHeader(row[c]) === headerNorm[c])).length;
    if (titled >= 2) {
      blank++;
      continue;
    }
    const rec = { sheet: name, row: r + 1, item_code: "", y_code: "", attributes: {} };
    const bad = [];
    fields.forEach((f, c) => {
      const v = row[c];
      switch (f) {
        case "catalog": rec.item_code = codeText(v); break;
        case "y_code": rec.y_code = yText(v); break;
        case "obsolete_catalog": rec.obsolete_catalog = codeText(v); break;
        case "obsolete_y_code": rec.obsolete_y_code = yText(v); break;
        case "description": rec.description = cellText(v).slice(0, 2000); break;
        case "hsn": rec.hsn = cellText(v).slice(0, 50); break;
        case "unit": rec.unit = cellText(v).slice(0, 30); break;
        case "lead_time": rec.lead_time = cellText(v).replace(/^lead\s*time\s*/i, "").slice(0, 100); break;
        case "remarks": rec.remarks = cellText(v).slice(0, 500); break;
        case "tax_rate": {
          const g = gstCell(v);
          if (Number.isNaN(g)) bad.push(`GST % is not a number ("${cellText(v).slice(0, 30)}")`);
          else if (g !== undefined) rec.tax_rate = g;
          break;
        }
        case "master_price":
        case "distributor_price":
        case "end_customer_price": {
          const p = priceCell(v);
          if (Number.isNaN(p)) bad.push(`${FIELD_LABELS[f]} is not a number ("${cellText(v).slice(0, 30)}")`);
          else if (p !== undefined) rec[f] = p;
          break;
        }
        case "attribute": {
          // An Excel date (days since 1900) under a "…Date…" title → yyyy-mm-dd.
          const isDate = typeof v === "number" && v > 20000 && v < 80000 && /date|go live/i.test(String(header[c] || ""));
          const text = isDate ? new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) : cellText(v);
          if (text && Object.keys(rec.attributes).length < 30) rec.attributes[attrKey(columnLabel(header, c))] = text.slice(0, 200);
          break;
        }
        default:
          break;
      }
    });
    const key = rec.item_code || rec.y_code;
    const priced = PRICE_KEYS.some((k) => rec[k] !== undefined);
    if (!key && !priced && !bad.length) {
      blank++;
      continue; // a heading / spacer row
    }
    if (!Object.keys(rec.attributes).length) delete rec.attributes;
    rec.key = key.toLowerCase();
    // Every PO item needs a catalog no. (a Y code alone is not enough).
    if (!key) rec.error = "No catalog or Y code";
    else if (!rec.item_code) rec.error = "No catalog no. (Y code only) — not imported";
    else if (bad.length) rec.error = bad.join("; ");
    else if (!priced) rec.error = "No price in this row";
    records.push(rec);
  }
  return { records, blank };
};

// Q5 default: sheets named "New Replacement Part…" first, then file order.
const defaultPriority = (names) => [
  ...names.filter((n) => /new\s*replacement/i.test(n)),
  ...names.filter((n) => !/new\s*replacement/i.test(n)),
];

// Same catalog inside one sheet → the later row is an error. Across sheets →
// one record per catalog: the user's choice for that catalog, else the sheet
// highest in `priority` (first = wins). Obsolete → replacement links from any
// sheet are kept on the winner (`replaces`).
const resolveDuplicates = (records, priority = [], choices = {}) => {
  const rank = (sheet) => {
    const i = priority.indexOf(sheet);
    return i < 0 ? priority.length : i;
  };
  const seenInSheet = new Map();
  const groups = new Map();
  const errors = [];
  for (const rec of records) {
    if (rec.error) {
      errors.push(rec);
      continue;
    }
    const sk = `${rec.sheet}\u0000${rec.key}`;
    if (seenInSheet.has(sk)) {
      errors.push({ ...rec, error: `Same catalog as row ${seenInSheet.get(sk)} of this sheet` });
      continue;
    }
    seenInSheet.set(sk, rec.row);
    if (!groups.has(rec.key)) groups.set(rec.key, []);
    groups.get(rec.key).push(rec);
  }
  const winners = [];
  const duplicates = [];
  const links = [];
  // Round 30 (S6): every sheet a catalog is on (file order), so the import
  // can take only the catalogs of the ticked sheets.
  const sheetsByKey = new Map();
  for (const [key, list] of groups) {
    sheetsByKey.set(key, list.map((r) => r.sheet));
    const ordered = [...list].sort((a, b) => rank(a.sheet) - rank(b.sheet));
    const picked = list.find((r) => r.sheet === choices[key]) || ordered[0];
    const replaces = [...new Set(list.flatMap((r) => [r.obsolete_catalog, r.obsolete_y_code]).filter(Boolean))];
    const win = { ...picked, price_sheet: picked.sheet };
    delete win.obsolete_catalog;
    delete win.obsolete_y_code;
    // Round 29 (S1): the item's SERIES is its "home" sheet — the first sheet
    // (file order) that lists it other than the "New Replacement Part…"
    // sheet — even when the price comes from the replacement sheet. So the
    // M210 series shows every M210 catalog, not only those missing elsewhere.
    if (list.length > 1) {
      const home = list.find((r) => !/new\s*replacement/i.test(r.sheet)) || picked;
      if (home.category !== undefined) win.category = home.category;
    }
    if (replaces.length) {
      win.replaces = replaces.slice(0, 10);
      list.filter((r) => r.obsolete_catalog).forEach((r) => links.push({ old_catalog: r.obsolete_catalog, new_catalog: win.item_code || win.y_code }));
    }
    winners.push(win);
    if (list.length > 1) {
      duplicates.push({
        key,
        catalog: picked.item_code || picked.y_code,
        chosen: picked.sheet,
        options: ordered.map((r) => ({ sheet: r.sheet, row: r.row, master_price: r.master_price ?? null, distributor_price: r.distributor_price ?? null, end_customer_price: r.end_customer_price ?? null })),
      });
    }
  }
  return { winners, duplicates, errors, links, sheetsByKey };
};

// Raw upload → clean sheets (arrays of arrays of primitive cells).
const cleanSheets = (sheets, { maxSheets = 60, maxRows = 20000, maxCols = 60 } = {}) => {
  if (!Array.isArray(sheets) || sheets.length === 0) return { error: "The workbook has no sheets" };
  if (sheets.length > maxSheets) return { error: `Too many sheets (more than ${maxSheets})` };
  const out = [];
  const names = new Set();
  for (const s of sheets) {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name.trim()) return { error: "Every sheet needs a name" };
    const name = s.name.trim().slice(0, 100);
    if (names.has(name)) return { error: `Sheet "${name}" is listed twice` };
    names.add(name);
    if (!Array.isArray(s.rows)) return { error: `Sheet "${name}": rows missing` };
    if (s.rows.length > maxRows) return { error: `Sheet "${name}" has more than ${maxRows} rows` };
    const rows = s.rows.map((r) =>
      Array.isArray(r)
        ? r.slice(0, maxCols).map((v) => (v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, 500)))
        : []
    );
    out.push({ ...s, name, rows });
  }
  return { sheets: out };
};

module.exports = {
  FIELDS,
  FIELD_LABELS,
  PRICE_KEYS,
  normHeader,
  headerField,
  autoFields,
  findHeaderRow,
  signatureOf,
  detectSheet,
  mappingProblem,
  extractRows,
  priceCell,
  gstCell,
  defaultPriority,
  resolveDuplicates,
  cleanSheets,
};
