// Pure pricing maths for Purchase Orders — no DB access, so the same rules
// are easy to test. Mirrored in the frontend's pages/purchase-orders/poCalc.ts
// for the live margin display; the server's result is the one that counts.
//
// Purchase PO (the only kind made now — Brady flow):
//   cost    = Master Distributor Price (else Distributor Price, marked "cost
//             from DP"); printed on the PO to Brady, rounded to the rupee (Q3).
//   selling = what the customer pays: defaults to the floor price (End User
//             Price, or Distributor Price for a "distributor" customer), may be
//             raised, never lowered (floorError).
//   margin  = (selling − cost) ÷ selling × 100 and ₹ (selling − cost) × qty —
//             shown on screen only, never printed or sent.
// Old Sales POs (type "sales") are read-only records; their maths is unchanged.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Q3: the PO to Brady prints whole-rupee unit rates (F1: 3207.37 → 3207).
const rupee = (n) => Math.round(Number(n) || 0);

// margin % = (selling − cost) ÷ selling × 100; null when cost isn't known.
const marginPct = (selling, cost) => (selling > 0 && cost > 0 ? round2(((selling - cost) / selling) * 100) : null);

// ₹ margin of one line = (selling − cost) × qty; null when cost isn't known.
const marginAmount = (selling, cost, qty) => (cost > 0 ? round2((selling - cost) * qty) : null);

// discount % = (list − selling) ÷ list × 100; negative when sold above list.
const discountPct = (selling, list) => (list > 0 ? round2(((list - selling) / list) * 100) : 0);

// Q1: which price is the cost — Master Distributor Price, else Distributor
// Price ("dp", flagged on the line), else the old landing cost ("landing").
const costOf = (item) => {
  if (Number(item?.master_price) > 0) return { cost_price: round2(item.master_price), cost_source: "mdp" };
  if (Number(item?.distributor_price) > 0) return { cost_price: round2(item.distributor_price), cost_source: "dp" };
  return { cost_price: round2(item?.cost_price || 0), cost_source: Number(item?.cost_price) > 0 ? "landing" : "none" };
};

// Fills a line's derived fields. `line` already has cost_price/list_price
// from the price master and the user's qty/selling_price/tax_rate.
const computeLine = (line, type) => {
  const qty = Math.max(Number(line.qty) || 0, 0);
  const cost = Number(line.cost_price) || 0;
  const list = Number(line.list_price) || 0;
  const selling = Number(line.selling_price) || 0;
  const taxRate = Math.max(Number(line.tax_rate) || 0, 0);
  const rate = type === "purchase" ? rupee(cost) : selling;
  const amount = round2(qty * rate);
  return {
    ...line,
    qty,
    cost_price: cost,
    list_price: list,
    selling_price: selling,
    tax_rate: taxRate,
    rate,
    amount,
    tax_amount: round2((amount * taxRate) / 100),
    discount_pct: discountPct(selling, list),
    margin_pct: marginPct(selling, cost),
    margin_amount: marginAmount(selling, cost, qty),
  };
};

const computeTotals = (lines, taxMode = "intra") => {
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.tax_amount, 0));
  const sellValue = round2(lines.reduce((s, l) => s + l.qty * l.selling_price, 0));
  const costValue = round2(lines.reduce((s, l) => s + l.qty * l.cost_price, 0));
  const half = round2(taxTotal / 2);
  const allCosted = costValue > 0 && lines.every((l) => l.cost_price > 0);
  return {
    subtotal,
    cgst: taxMode === "intra" ? half : 0,
    sgst: taxMode === "intra" ? round2(taxTotal - half) : 0,
    igst: taxMode === "inter" ? taxTotal : 0,
    tax_total: taxTotal,
    grand_total: round2(subtotal + taxTotal),
    sell_value: sellValue,
    cost_value: costValue,
    margin_pct: allCosted ? marginPct(sellValue, costValue) : null,
    margin_amount: allCosted ? round2(sellValue - costValue) : null,
  };
};

// Reasons one line needs the approver's attention (empty = nothing special).
// Since every PO now goes for approval (R4) these are information for the
// approver, not the trigger. A missing cost price fails the margin check
// rather than passing it: the margin can't be verified.
const lineBreaches = (line, rule) => {
  const out = [];
  if (rule.min_margin_pct !== null && rule.min_margin_pct !== undefined) {
    if (!(line.cost_price > 0)) out.push("Cost price not set, margin can't be checked");
    else if (line.margin_pct === null || line.margin_pct < rule.min_margin_pct) {
      out.push(`Margin ${line.margin_pct ?? 0}% is below the ${rule.min_margin_pct}% minimum`);
    }
  }
  if (rule.max_discount_pct !== null && rule.max_discount_pct !== undefined && line.list_price > 0) {
    if (line.discount_pct > rule.max_discount_pct) {
      out.push(`Discount ${line.discount_pct}% is above the ${rule.max_discount_pct}% maximum`);
    }
  }
  if (rule.price_floor) {
    // Price only up: below list never gets here (floorError refuses it); a
    // raise above the list price is shown to the approver.
    if (line.list_price > 0 && line.selling_price > line.list_price) {
      out.push(`Price raised from ${line.list_price} to ${line.selling_price}`);
    }
  } else if (rule.allow_below_list === false && line.list_price > 0 && line.selling_price < line.list_price) {
    out.push(`Price ${line.selling_price} is below the list price ${line.list_price}`);
  }
  // Q1: no Master Distributor Price on the price list for this item.
  if (line.cost_source === "dp") out.push("Cost from DP (no Master Distributor Price)");
  return out;
};

// "Price only up" (rule.price_floor — always on for Purchase POs): a selling
// price below the floor price is refused outright. Lines with no floor price
// (0) are not checked. Returns the reason, or null when the line is fine.
const floorError = (line, rule) =>
  rule?.price_floor && line.list_price > 0 && line.selling_price < line.list_price
    ? `price can't be lower than the price-master price ${line.list_price}`
    : null;

// Computes every line, the totals and the attention list for one PO.
// approvalRequired = something needs the approver's attention (information
// only for Purchase POs: they always go for approval).
const evaluatePo = ({ lines, type, taxMode, rule }) => {
  const computed = lines.map((l) => {
    const line = computeLine(l, type);
    return { ...line, breaches: lineBreaches(line, rule) };
  });
  const reasons = computed.flatMap((l, i) => l.breaches.map((b) => `Line ${i + 1} (${l.name}): ${b}`));
  return { lines: computed, totals: computeTotals(computed, taxMode), approvalRequired: reasons.length > 0, reasons };
};

// ─── Financial year + PO number (R2) ───────────────────────────────────────
// April–March, counted in India time (UTC+5:30) so 31 Mar 23:30 IST is still
// the old year. Returns "26-27" for any date from 1 Apr 2026 to 31 Mar 2027.
const IST_MS = 330 * 60 * 1000;
const fyOf = (date) => {
  const d = new Date(date === undefined || date === null ? Date.now() : date);
  if (isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + IST_MS);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  const yy = (n) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
};

// "<prefix>/<running no., 2+ digits>/<FY>" e.g. DA/07/26-27, DA/100/26-27.
const formatPoNumber = (prefix, n, fy) => `${prefix}/${String(n).padStart(2, "0")}/${fy}`;

module.exports = {
  round2,
  rupee,
  marginPct,
  marginAmount,
  discountPct,
  costOf,
  computeLine,
  computeTotals,
  lineBreaches,
  floorError,
  evaluatePo,
  fyOf,
  formatPoNumber,
};
