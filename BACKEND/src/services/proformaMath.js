// Pure maths for Proforma Invoices (R5) — the same formulas as the client's
// proforma sheet (F3), copied exactly:
//   Taxable          = ROUND(qty × rate × (1 − disc), 2)
//   IGST line total  = taxable + ROUND(taxable × gst, 2)
//   CGST+SGST total  = taxable + 2 × ROUND(taxable × gst / 2, 2)
//   Grand total      = Σ line totals
//   IGST             = ROUND(grand − taxable subtotal, 2)
//   CGST = SGST      = ROUND((grand − taxable subtotal) / 2, 2)
//   Balance payable  = ROUND(grand − advance, 2)
// Mirrored in CRM-FRONTEND-NEW/src/pages/purchase-orders/proformaCalc.ts.

const round2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;

const TAX_TYPES = ["igst", "cgst_sgst"];

// One line: disc and gst are percentages (10 = 10 %).
const proformaLine = (line, taxType) => {
  const qty = Number(line.qty) || 0;
  const rate = Number(line.rate) || 0;
  const disc = (Number(line.disc_pct) || 0) / 100;
  const gst = (Number(line.gst_pct) || 0) / 100;
  const taxable = round2(qty * rate * (1 - disc));
  const tax = taxType === "igst" ? round2(taxable * gst) : 2 * round2((taxable * gst) / 2);
  return { ...line, taxable, tax: round2(tax), total: round2(taxable + tax) };
};

const proformaTotals = (lines, taxType, advance = 0) => {
  const taxable = round2(lines.reduce((s, l) => s + l.taxable, 0));
  const grand = round2(lines.reduce((s, l) => s + l.total, 0));
  const taxAll = round2(grand - taxable);
  const half = taxType === "cgst_sgst" ? round2(taxAll / 2) : 0;
  const adv = round2(advance);
  return {
    taxable,
    cgst: half,
    sgst: half,
    igst: taxType === "igst" ? taxAll : 0,
    grand_total: grand,
    advance: adv,
    balance: round2(grand - adv),
  };
};

const computeProforma = ({ lines, taxType, advance }) => {
  const computed = (lines || []).map((l) => proformaLine(l, taxType));
  return { lines: computed, totals: proformaTotals(computed, taxType, advance) };
};

// ─── Amount in words (Indian system: thousand, lakh, crore) ────────────────
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`);
const below1000 = (n) => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
};

// Whole number → words: 1,37,540 → "one lakh thirty seven thousand five hundred forty".
const integerWords = (n) => {
  if (n === 0) return "zero";
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  if (crore) parts.push(`${integerWords(crore)} crore`);
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
};

// "One lakh thirty seven thousand five hundred forty rupees and eighty paisa only."
// Always made from the real total (never typed).
const amountInWords = (amount) => {
  const paiseAll = Math.round(Math.abs(Number(amount) || 0) * 100);
  const rupees = Math.floor(paiseAll / 100);
  const paise = paiseAll % 100;
  let text = `${integerWords(rupees)} ${rupees === 1 ? "rupee" : "rupees"}`;
  if (paise) text += ` and ${integerWords(paise)} paisa`;
  text += " only.";
  return text.charAt(0).toUpperCase() + text.slice(1);
};

module.exports = { round2, TAX_TYPES, proformaLine, proformaTotals, computeProforma, amountInWords, integerWords };
