// Round 29 (S3): "Read items from the customer PO". Turns the customer's own
// purchase order (a text PDF or an .xlsx) into rows of cells, then finds the
// lines whose catalog no. (or Y code, or an obsolete catalog → its
// replacement) is in PO Items, with the qty and rate on the same row.
//
//   readCustomerPoFile(buffer, name) → { kind, rows: string[][] } | throws
//   matchLines(rows, items)          → { lines, customer_po_number, customer_po_date }
//
// No OCR: an image or a scanned PDF (no text layer) is refused with
// "Can't read a scanned file — add items by hand". Nothing is saved here.
//
// PDF text: pdf.js 1.10 bundled with pdf-parse 1.1.1 (only getTextContent —
// no rendering, eval switched off). Excel: the xlsx package already used for
// the price list.

const SCANNED = "Can't read a scanned file — add items by hand";
const MAX_PAGES = 30;
const MAX_ROWS = 5000;

const readError = (message) => Object.assign(new Error(message), { status: 400 });

// What the file really is, from its first bytes (never the name alone).
const sniff = (buffer, name = "") => {
  if (!buffer || buffer.length === 0) return "empty";
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image";
  if (head.subarray(0, 4).toString("latin1") === "GIF8" || (head.subarray(0, 4).toString("latin1") === "RIFF" && /\.webp$/i.test(name))) return "image";
  if (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) return "image"; // TIFF (scanner)
  if (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a) return "image";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return /\.xlsx$|\.xlsm$/i.test(name) || !/\.\w+$/.test(name) ? "xlsx" : "zip";
  return "other";
};

let pdfjs = null;
const loadPdfJs = () => {
  if (pdfjs) return pdfjs;
  // eslint-disable-next-line global-require
  pdfjs = require("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js");
  pdfjs.disableWorker = true;
  pdfjs.isEvalSupported = false; // text only — never compile font code
  pdfjs.verbosity = 0;
  return pdfjs;
};

// One PDF page's text items → rows (same baseline ±3 pt), cells left → right.
const pageRows = (items) => {
  const groups = [];
  const sorted = items
    .filter((i) => typeof i.str === "string")
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: Number(i.width) || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const g = groups.find((x) => Math.abs(x.y - it.y) < 3);
    if (g) g.items.push(it);
    else groups.push({ y: it.y, items: [it] });
  }
  // Each row keeps the centre x of its cells (row.xs) so a data cell can be
  // put under its table header column even when a cell is blank (a blank PDF
  // cell has no text item at all, so cell indexes alone shift).
  return groups.map((g) => {
    const its = g.items.sort((a, b) => a.x - b.x);
    const row = its.map((i) => i.s.replace(/\s+/g, " ").trim());
    Object.defineProperty(row, "xs", { value: its.map((i) => i.x + i.w / 2), enumerable: false });
    return row;
  });
};

const readPdf = async (buffer) => {
  const PDFJS = loadPdfJs();
  let doc;
  try {
    doc = await PDFJS.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true });
  } catch (err) {
    if (err && err.name === "PasswordException") throw readError("This PDF is password-protected — add items by hand");
    throw readError("This PDF can't be read — add items by hand");
  }
  try {
    const rows = [];
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      rows.push(...pageRows(tc.items));
      if (rows.length > MAX_ROWS) break;
    }
    const chars = rows.flat().join("").replace(/\s/g, "").length;
    // No text layer (or only a few stray characters): a scanned page.
    if (chars < 8) throw readError(SCANNED);
    return rows.slice(0, MAX_ROWS);
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
};

const readXlsx = (buffer) => {
  // eslint-disable-next-line global-require
  const XLSX = require("xlsx");
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellFormula: false, cellHTML: false });
  } catch {
    throw readError("This Excel file can't be read — add items by hand");
  }
  const rows = [];
  for (const name of wb.SheetNames.slice(0, 10)) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    for (const r of data) {
      rows.push((r || []).slice(0, 40).map((v) => (v === null || v === undefined ? "" : typeof v === "number" ? v : String(v).replace(/\s+/g, " ").trim())));
      if (rows.length > MAX_ROWS) break;
    }
  }
  if (!rows.some((r) => r.some((c) => String(c).trim()))) throw readError("The Excel file is empty");
  return rows.slice(0, MAX_ROWS);
};

const readCustomerPoFile = async (buffer, name = "") => {
  const kind = sniff(buffer, name);
  if (kind === "empty") throw readError("The file is empty");
  if (kind === "image") throw readError(SCANNED);
  if (kind === "pdf") return { kind, rows: await readPdf(buffer) };
  if (kind === "xlsx") return { kind, rows: readXlsx(buffer) };
  throw readError("Only a PDF or Excel (.xlsx) customer PO can be read");
};

// ─── Line detection ────────────────────────────────────────────────────────

// "5,000.00" / "₹ 3,000" / "Rs. 1,20,000.50" / 2 → number; else null.
const parseNum = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/\s*(\/-)$/, "");
  if (!/^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t.replace(/,/g, ""));
};

const CODE_TOKEN = /[A-Za-z0-9][A-Za-z0-9\-/._]*[A-Za-z0-9]/g;
const lower = (s) => String(s || "").toLowerCase();

// PO Items → lookups by catalog, Y code and obsolete catalog / Y code.
const indexItems = (items) => {
  const byCode = new Map();
  const byY = new Map();
  const byOld = new Map();
  for (const it of items) {
    if (it.item_code) byCode.set(lower(it.item_code), it);
    if (it.y_code && !byY.has(lower(it.y_code))) byY.set(lower(it.y_code), it);
    for (const old of it.replaces || []) if (!byOld.has(lower(old))) byOld.set(lower(old), it);
  }
  return { byCode, byY, byOld };
};

// The first PO item named in one row: catalog no. → Y code → obsolete catalog
// (an item that replaces it, or an obsolete item → its replacement).
const findItem = (cells, idx) => {
  let fallback = null;
  for (let c = 0; c < cells.length; c++) {
    const text = String(cells[c] ?? "");
    for (const m of text.matchAll(CODE_TOKEN)) {
      const tok = lower(m[0]);
      const hit = idx.byCode.get(tok);
      if (hit) {
        if (hit.replaced_by && idx.byCode.get(lower(hit.replaced_by))) {
          return { item: idx.byCode.get(lower(hit.replaced_by)), cell: c, token: m[0], note: `${hit.item_code} is obsolete — replaced by ${hit.replaced_by}` };
        }
        return { item: hit, cell: c, token: m[0] };
      }
      if (!fallback && idx.byY.get(tok)) fallback = { item: idx.byY.get(tok), cell: c, token: m[0], note: `found by Y code ${m[0].toUpperCase()}` };
      if (!fallback && idx.byOld.get(tok)) {
        const it = idx.byOld.get(tok);
        fallback = { item: it, cell: c, token: m[0], note: `${m[0]} is obsolete — replaced by ${it.item_code}` };
      }
    }
  }
  return fallback;
};

// qty and rate from the cells after the item: first look for qty × rate =
// amount (within 1 %), else the first whole number 1-1,00,000 that isn't an
// HSN-looking code, and the number after it as the rate.
// Round 30: the fallback only takes a qty that is followed by a rate and isn't
// the same number as the rate / amount after it — a blank Qty cell must not
// turn the rate into the qty (3000 × cost = ₹57 lakh). Otherwise qty = null
// (amber "qty unreadable").
const qtyAndRate = (cells, from) => {
  const nums = [];
  for (let c = from; c < cells.length; c++) {
    const raw = String(cells[c] ?? "").trim();
    if (!raw || /%$/.test(raw) || /^Y\d{4,}$/i.test(raw)) continue;
    const n = parseNum(cells[c]);
    if (n !== null) nums.push({ n, raw, hsnLike: typeof cells[c] !== "number" && /^(\d{4}|\d{6}|\d{8})$/.test(raw) });
  }
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      for (let k = j + 1; k < nums.length; k++) {
        const [q, r, a] = [nums[i].n, nums[j].n, nums[k].n];
        if (Number.isInteger(q) && q > 0 && r > 0 && Math.abs(q * r - a) <= Math.max(1, a * 0.01)) return { qty: q, rate: r };
      }
    }
  }
  const qi = nums.findIndex((x) => Number.isInteger(x.n) && x.n >= 1 && x.n <= 100000 && !x.hsnLike);
  const firstRate = () => (nums.find((x) => x.n > 0 && !x.hsnLike) || {}).n ?? null;
  if (qi < 0) return { qty: null, rate: firstRate() };
  const after = nums.slice(qi + 1).filter((x) => !x.hsnLike);
  const rate = after.find((x) => x.n > 0);
  if (!rate || after.some((x) => x.n === nums[qi].n)) return { qty: null, rate: rate ? rate.n : nums[qi].n };
  return { qty: nums[qi].n, rate: rate.n };
};

// ─── Table header columns ──────────────────────────────────────────────────
const QTY_HEAD = /^(qty|qnty|quantity|order\s*qty|qty\s*\(.*\))\.?$/i;
const RATE_HEAD = /(rate|price)/i;
const AMOUNT_HEAD = /(amount|taxable|total|value)/i;

// A table header row: has a Qty cell and a Rate / Amount cell. Positions are
// the PDF centre x (row.xs) or, for Excel, the cell index.
const headerColumns = (cells) => {
  const pos = (c) => (cells.xs ? cells.xs[c] : c);
  const cols = [];
  cells.forEach((cell, c) => {
    const t = String(cell ?? "").trim();
    if (!t || t.length > 30) return;
    if (QTY_HEAD.test(t)) cols.push({ kind: "qty", pos: pos(c) });
    else if (RATE_HEAD.test(t) && !AMOUNT_HEAD.test(t)) cols.push({ kind: "rate", pos: pos(c) });
    else if (AMOUNT_HEAD.test(t)) cols.push({ kind: "amount", pos: pos(c) });
    else cols.push({ kind: "other", pos: pos(c) });
  });
  if (!cols.some((x) => x.kind === "qty") || !cols.some((x) => x.kind === "rate" || x.kind === "amount")) return null;
  return { cols, pdf: !!cells.xs };
};

// qty / rate of a data row from the header columns: each cell after the item
// goes under the nearest header column. No cell under Qty → qty null.
const qtyAndRateByHeader = (cells, from, header) => {
  if (header.pdf !== !!cells.xs) return null;
  const pos = (c) => (cells.xs ? cells.xs[c] : c);
  const under = { qty: [], rate: [] };
  for (let c = from; c < cells.length; c++) {
    if (String(cells[c] ?? "").trim() === "") continue;
    let best = null;
    for (const col of header.cols) {
      const d = Math.abs(col.pos - pos(c));
      if (!best || d < best.d) best = { d, col };
    }
    if (best && (best.col.kind === "qty" || best.col.kind === "rate")) under[best.col.kind].push(cells[c]);
  }
  const q = under.qty.map(parseNum).find((n) => n !== null);
  const r = under.rate.map(parseNum).find((n) => n !== null);
  const qty = Number.isInteger(q) && q >= 1 && q <= 100000 ? q : null;
  const rate = r !== undefined && r !== null && r > 0 ? r : header.cols.some((x) => x.kind === "rate") ? null : qtyAndRate(cells, from).rate;
  return { qty, rate };
};

// A row that looks like an order line without a known item: starts with a
// serial number and has a code-looking token plus a number.
const looksLikeLine = (cells) => {
  const first = String(cells[0] ?? "").trim();
  if (!/^\d{1,3}\.?$/.test(first)) return false;
  const rest = cells.slice(1).map((c) => String(c ?? "")).join(" ");
  return /[A-Za-z]+\d|\d+[-/][A-Za-z0-9]/.test(rest) && cells.slice(1).some((c) => parseNum(c) !== null);
};

const DATE_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$|^(\d{4})-(\d{2})-(\d{2})$/;
const parseDate = (v) => {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = String(v ?? "").trim().match(DATE_RE);
  if (!m) return null;
  const [d, mo, y] = m[1] ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[6]), Number(m[5]), Number(m[4])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const PO_NO_LABEL = /^(customer\s*)?(p\.?\s*o\.?|purchase\s*order|order)\s*(no\.?|number|num|#)\s*:?$/i;
const PO_DATE_LABEL = /^(p\.?\s*o\.?|order|purchase\s*order)\s*date\s*:?$/i;

// Customer PO no. / date from "PO No. | SGE/PO/2026/145" style label cells
// (or "PO No.: X" in one cell).
const headerInfo = (rows) => {
  let number = "";
  let date = "";
  for (const cells of rows.slice(0, 60)) {
    for (let c = 0; c < cells.length; c++) {
      const t = String(cells[c] ?? "").trim();
      const inline = t.match(/^(?:p\.?\s*o\.?|purchase\s*order|order)\s*(?:no\.?|number|#)\s*:\s*(.+)$/i);
      if (!number && inline) number = inline[1].trim();
      const inlineDate = t.match(/^(?:p\.?\s*o\.?|order)\s*date\s*:\s*(.+)$/i);
      if (!date && inlineDate) date = parseDate(inlineDate[1]) || "";
      const next = cells.slice(c + 1).find((x) => String(x ?? "").trim());
      if (!number && PO_NO_LABEL.test(t) && next) number = String(next).trim();
      if (!date && PO_DATE_LABEL.test(t) && next) date = parseDate(next) || "";
    }
    if (number && date) break;
  }
  if (number && (number.length > 60 || !/^[A-Za-z0-9 \-_.()/]+$/.test(number))) number = "";
  return { customer_po_number: number, customer_po_date: date };
};

// Rows → review lines. status: "matched" (green), "not_found" (red, with the
// text read), "qty_unreadable" (amber). The same item twice is merged (qty
// added). `items` = the company's PO items (lean).
const matchLines = (rows, items) => {
  const idx = indexItems(items);
  const lines = [];
  let header = null;
  for (const cells of rows) {
    if (!cells || !cells.length) continue;
    const head = headerColumns(cells);
    if (head) {
      header = head;
      continue;
    }
    const text = cells.map((c) => String(c ?? "").trim()).filter(Boolean).join(" | ").slice(0, 300);
    const hit = findItem(cells, idx);
    if (hit) {
      const { qty, rate } = (header && qtyAndRateByHeader(cells, hit.cell + 1, header)) || qtyAndRate(cells, hit.cell + 1);
      const item = hit.item;
      if (item.active === false) {
        lines.push({ status: "not_found", text, catalog: hit.token, note: `${item.item_code || item.name} is switched off in PO Items` });
        continue;
      }
      const line = { status: qty ? "matched" : "qty_unreadable", text, catalog: hit.token, item_id: String(item._id), item_code: item.item_code || "", qty: qty || null, rate: rate ?? null, note: hit.note || "" };
      const same = lines.find((l) => l.item_id && l.item_id === line.item_id);
      if (same && same.qty && line.qty) {
        same.qty += line.qty;
        same.note = [same.note, "same item on more than one line — qty added"].filter(Boolean).join("; ");
        continue;
      }
      lines.push(line);
      continue;
    }
    if (looksLikeLine(cells)) lines.push({ status: "not_found", text, catalog: (text.match(/[A-Za-z]+[A-Za-z0-9]*[-/][A-Za-z0-9\-/.]+/) || [""])[0], note: "Not in PO Items" });
  }
  return { lines, ...headerInfo(rows) };
};

module.exports = { readCustomerPoFile, matchLines, sniff, parseNum, qtyAndRate, headerColumns, qtyAndRateByHeader, headerInfo, parseDate, pageRows, SCANNED };
