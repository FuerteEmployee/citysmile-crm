// Plain-Node acceptance check for services/gstService.js — no test runner
// dependency. Run with: node scripts/verify-gst-service.js
const assert = require("assert");
const gst = require("../src/services/gstService");

let passed = 0;
const check = (label, actual, expected) => {
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  passed++;
  console.log(`  ok  ${label} = ${actual}`);
};

console.log("Case 1: Qty 10 x Rs.100, 10% discount, GST 18%, intra-state");
{
  const line = gst.calculateLine({ qty: 10, rate: 100, discountPct: 10, gstRate: 18 });
  check("taxableValue", line.taxableValue, 900);
  const split = gst.splitTax({ gstAmount: line.gstAmount, companyStateCode: "24", placeOfSupplyStateCode: "24" });
  check("cgst", split.cgst, 81);
  check("sgst", split.sgst, 81);
  check("igst", split.igst, 0);
  const totals = gst.calculateDocumentTotals([{ ...line, ...split }]);
  check("total", totals.payable, 1062);
}

console.log("\nCase 2: Same as #1 but inter-state");
{
  const line = gst.calculateLine({ qty: 10, rate: 100, discountPct: 10, gstRate: 18 });
  const split = gst.splitTax({ gstAmount: line.gstAmount, companyStateCode: "24", placeOfSupplyStateCode: "27" });
  check("cgst", split.cgst, 0);
  check("sgst", split.sgst, 0);
  check("igst", split.igst, 162);
  const totals = gst.calculateDocumentTotals([{ ...line, ...split }]);
  check("total", totals.payable, 1062);
}

console.log("\nCase 3: Tax-inclusive rate Rs.118, qty 1, GST 18%");
{
  const line = gst.calculateLine({ qty: 1, rate: 118, gstRate: 18, taxInclusive: true });
  check("taxableValue", line.taxableValue, 100);
  check("gstAmount", line.gstAmount, 18);
  check("lineTotal", line.lineTotal, 118);
}

console.log("\nCase 4: One line at 5%, one at 18% -> two summary rows, grand total = sum");
{
  const lineA = gst.calculateLine({ qty: 1, rate: 1000, gstRate: 5 });
  const splitA = gst.splitTax({ gstAmount: lineA.gstAmount, companyStateCode: "24", placeOfSupplyStateCode: "24" });
  const lineB = gst.calculateLine({ qty: 1, rate: 1000, gstRate: 18 });
  const splitB = gst.splitTax({ gstAmount: lineB.gstAmount, companyStateCode: "24", placeOfSupplyStateCode: "24" });
  const lines = [{ ...lineA, ...splitA }, { ...lineB, ...splitB }];
  const summary = gst.summarizeByRate(lines);
  check("summary rows", summary.length, 2);
  const totals = gst.calculateDocumentTotals(lines);
  const summedFromRows = summary.reduce((s, r) => s + r.taxableValue + r.cgst + r.sgst + r.igst + r.cessAmount, 0);
  check("grand total equals sum of rate rows", Math.round(summedFromRows * 100) / 100 === totals.grand_total, true);
}

console.log("\nCase 8: Grand total 1061.60 -> round_off 0.40, payable 1062.00");
{
  // A line engineered to land on subtotal+gst = 1061.60 exactly.
  const line = gst.calculateLine({ qty: 1, rate: 899.66, gstRate: 18 });
  // 899.66 * 1.18 = 1061.5988 -> rounds to 1061.60 at line level
  const totals = gst.calculateDocumentTotals([{ ...line, cgst: 0, sgst: 0, igst: line.gstAmount }]);
  check("round_off", totals.round_off, 0.4);
  check("payable", totals.payable, 1062);
}

console.log(`\n${passed} checks passed.`);
