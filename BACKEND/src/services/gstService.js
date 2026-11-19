// ============================================================================
// Single shared GST calculation service. Every Sales/Purchases module must
// compute tax by calling into this file — never re-derive the formula
// locally. See §4.2 of the GST implementation spec for the source rules.
// ============================================================================

const { stateNameFromGstin, GST_STATE_CODES } = require("../utils/gstStateCodes");

const ALLOWED_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

// Round half-up to 2 decimals. Math.round() already rounds .5 up for
// positive numbers, which is all GST amounts ever are.
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Standard 15-character GSTIN pattern: 2-digit state code, 10-char PAN,
// 1-digit entity code, 'Z' by convention, 1 checksum char. This validates
// the structural pattern; it does NOT verify the checksum digit itself
// (that requires the official mod-36 algorithm) — treat a pattern match as
// "well-formed", not "guaranteed real".
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function isValidGstinFormat(gstin) {
  return GSTIN_PATTERN.test(String(gstin || "").trim().toUpperCase());
}

function stateCodeFromGstin(gstin) {
  const code = String(gstin || "").trim().substring(0, 2);
  return GST_STATE_CODES[code] ? code : "";
}

// Use this at the form/create-document layer for NEW documents. Deliberately
// not called inside calculateLine() — see the doc comment there.
function isAllowedGstRate(rate) {
  return ALLOWED_GST_RATES.includes(Number(rate));
}

/**
 * Computes one line's taxable value, GST, and cess.
 * @param {object} line
 * @param {number} line.qty
 * @param {number} line.rate
 * @param {number} [line.discountPct] - percentage discount (0-100)
 * @param {number} [line.discountFlat] - flat discount amount, used only if discountPct is not set
 * @param {number} line.gstRate - should be one of ALLOWED_GST_RATES; use isAllowedGstRate()
 *   at the form/validation layer to enforce this against new user input. Not
 *   enforced here so this function stays safe to run over years of existing
 *   Purchases/Invoices data that may predate the rate whitelist.
 * @param {number} [line.cessRate]
 * @param {boolean} [line.taxInclusive] - true if `rate` already includes GST
 */
function calculateLine({ qty, rate, discountPct, discountFlat, gstRate, cessRate = 0, taxInclusive = false }) {
  const quantity = Number(qty) || 0;
  const unitRate = Number(rate) || 0;
  const rate_ = Math.max(0, Number(gstRate) || 0);
  const cess = Number(cessRate) || 0;

  const gross = quantity * unitRate;
  const discountAmt = discountPct ? gross * (Number(discountPct) / 100) : (Number(discountFlat) || 0);
  const grossAfterDiscount = gross - discountAmt;

  const taxableValue = taxInclusive
    ? (grossAfterDiscount * 100) / (100 + rate_)
    : grossAfterDiscount;

  const gstAmount = (taxableValue * rate_) / 100;
  const cessAmount = (taxableValue * cess) / 100;

  // Round at the line level first, then derive the line total from the
  // rounded pieces — never from the unrounded intermediate values.
  const roundedTaxable = round2(taxableValue);
  const roundedGst = round2(gstAmount);
  const roundedCess = round2(cessAmount);

  return {
    gross: round2(gross),
    discountAmt: round2(discountAmt),
    taxableValue: roundedTaxable,
    gstRate: rate_,
    gstAmount: roundedGst,
    cessRate: cess,
    cessAmount: roundedCess,
    lineTotal: round2(roundedTaxable + roundedGst + roundedCess),
  };
}

/**
 * Splits a line's GST amount into CGST+SGST (intra-state) or IGST (inter-state),
 * decided once per document from place of supply vs. the company's home state.
 * @param {number} gstAmount
 * @param {string} companyStateCode - 2-digit GSTIN state code for the company
 * @param {string} placeOfSupplyStateCode - 2-digit GSTIN state code for the counterparty
 * @param {boolean} [isExportOrSez] - export/SEZ-without-payment-of-tax: forces rate 0
 */
function splitTax({ gstAmount, companyStateCode, placeOfSupplyStateCode, isExportOrSez = false }) {
  if (isExportOrSez) {
    return { cgst: 0, sgst: 0, igst: 0, reason: "Export/SEZ supply without payment of tax" };
  }

  const amount = Number(gstAmount) || 0;
  const isIntraState = String(companyStateCode || "") === String(placeOfSupplyStateCode || "");

  if (isIntraState) {
    return { cgst: round2(amount / 2), sgst: round2(amount / 2), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: round2(amount) };
}

/**
 * Sums a document's already-computed lines (each the output of calculateLine +
 * splitTax merged together) into subtotal/tax totals/grand total, with the
 * round-off stored separately rather than folded silently into the total.
 * @param {Array<{taxableValue:number, cgst:number, sgst:number, igst:number, cessAmount:number}>} lines
 * @param {number} [shippingTaxablePortion]
 */
function calculateDocumentTotals(lines, shippingTaxablePortion = 0) {
  const totals = lines.reduce(
    (acc, l) => {
      acc.subtotal += Number(l.taxableValue) || 0;
      acc.total_cgst += Number(l.cgst) || 0;
      acc.total_sgst += Number(l.sgst) || 0;
      acc.total_igst += Number(l.igst) || 0;
      acc.total_cess += Number(l.cessAmount) || 0;
      return acc;
    },
    { subtotal: 0, total_cgst: 0, total_sgst: 0, total_igst: 0, total_cess: 0 }
  );

  Object.keys(totals).forEach((k) => (totals[k] = round2(totals[k])));

  const shipping = round2(shippingTaxablePortion);
  const grandTotal = round2(
    totals.subtotal + totals.total_cgst + totals.total_sgst + totals.total_igst + totals.total_cess + shipping
  );
  const payableRounded = Math.round(grandTotal);
  const roundOff = round2(payableRounded - grandTotal);

  return {
    ...totals,
    shipping_taxable_portion: shipping,
    grand_total: grandTotal,
    round_off: roundOff,
    payable: payableRounded,
  };
}

/**
 * Groups computed lines by GST rate for the printed/GSTR-facing summary panel.
 */
function summarizeByRate(lines) {
  const byRate = new Map();
  lines.forEach((l) => {
    const key = l.gstRate;
    if (!byRate.has(key)) {
      byRate.set(key, { gstRate: key, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cessAmount: 0 });
    }
    const row = byRate.get(key);
    row.taxableValue += Number(l.taxableValue) || 0;
    row.cgst += Number(l.cgst) || 0;
    row.sgst += Number(l.sgst) || 0;
    row.igst += Number(l.igst) || 0;
    row.cessAmount += Number(l.cessAmount) || 0;
  });
  return [...byRate.values()]
    .sort((a, b) => a.gstRate - b.gstRate)
    .map((row) => ({
      gstRate: row.gstRate,
      taxableValue: round2(row.taxableValue),
      cgst: round2(row.cgst),
      sgst: round2(row.sgst),
      igst: round2(row.igst),
      cessAmount: round2(row.cessAmount),
    }));
}

module.exports = {
  ALLOWED_GST_RATES,
  round2,
  isValidGstinFormat,
  isAllowedGstRate,
  stateCodeFromGstin,
  stateNameFromGstin,
  calculateLine,
  splitTax,
  calculateDocumentTotals,
  summarizeByRate,
};
