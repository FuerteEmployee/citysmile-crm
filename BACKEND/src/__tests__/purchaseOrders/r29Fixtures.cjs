// Round 29 test fixtures (named .cjs so jest doesn't run it as a suite).
//  - makePdf(rows): a small TEXT PDF (Helvetica), each row = cells placed left
//    to right on one line — like a customer's PO table.
//  - makePdf([]) / blankPdf(): a PDF with no text layer (a "scanned" page).
//  - xlsxPo(rows): an .xlsx customer PO.
//  - SAMPLES: the 3 sample customer POs (test-prompts/samples, read-only).
//  - BRADY: PO items with the real F2 prices of the catalogs in the samples.
const path = require("path");
const fs = require("fs");

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function makePdf(rows = [], { pageText = true } = {}) {
  const parts = [];
  let y = 800;
  for (const cells of rows) {
    let x = 40;
    for (const c of cells) {
      if (c !== "" && c !== null && c !== undefined) parts.push(`BT /F1 9 Tf ${x} ${y} Td (${esc(c)}) Tj ET`);
      x += 70;
    }
    y -= 14;
  }
  // A "scanned" page: only a filled rectangle (no text at all).
  const content = pageText && parts.length ? parts.join("\n") : "0 0 0 rg 40 400 200 200 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const blankPdf = () => makePdf([], { pageText: false });

function xlsxPo(rows) {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "PO");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const SAMPLE_DIR = process.env.PO_SAMPLES_DIR || path.resolve(__dirname, "../../../../test-prompts/samples");
const SAMPLES = {
  crystal: path.join(SAMPLE_DIR, "Sample_Customer_PO_Crystal_Bunglows_F1.pdf"),
  omsai: path.join(SAMPLE_DIR, "Sample_Customer_PO_Om_Sai_Infra_F1.pdf"),
  sge: path.join(SAMPLE_DIR, "Sample_Customer_PO_SGE-PO-2026-145.pdf"),
};
const hasSamples = Object.values(SAMPLES).every((p) => fs.existsSync(p));
// Per-sample gate, so the tests of the samples that are present still run.
const hasSample = (...keys) => keys.every((k) => fs.existsSync(SAMPLES[k]));
const sample = (k) => fs.readFileSync(SAMPLES[k]);

// The real F2 values (winner sheet per the default priority) of the catalogs
// used in the sample POs — so the expected totals are the real ones.
const BRADY = [
  { item_code: "M7-84-499", y_code: "Y5075406", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, category: "New Replacement Part M611 M710", replaces: ["M71-84-499", "Y981214"], tax_rate: 18 },
  { item_code: "M21-500-423", y_code: "Y4900629", master_price: 1914.44, distributor_price: 2203.04, end_customer_price: 2753.8, category: "M210", tax_rate: 18 },
  { item_code: "M21-750-423", y_code: "Y4900648", master_price: 1986.18, distributor_price: 2285.59, end_customer_price: 2856.99, category: "M210", tax_rate: 18 },
  { item_code: "M21-375-423", y_code: "Y4900609", master_price: 1871.89, distributor_price: 2154.07, end_customer_price: 2692.59, category: "M210", tax_rate: 18 },
  { item_code: "M7-R4300", y_code: "Y5074256", master_price: 1869.46, distributor_price: 2151.28, end_customer_price: 2689.1, category: "New Replacement Part M611 M710", replaces: ["M71-R4300", "Y958908"], tax_rate: 18 },
];

// Jest 30 also collects .cjs files under __tests__: run as its own suite, it
// only checks the fixtures (same pattern as poStack.cjs / priceListFixtures.cjs).
const runAsSuite = (() => {
  try {
    const tp = typeof expect !== "undefined" && expect.getState().testPath;
    return !!tp && path.resolve(tp).toLowerCase() === __filename.toLowerCase();
  } catch {
    return false;
  }
})();
if (runAsSuite) {
  test("r29 fixtures: the PDF builder makes a real %PDF- file; samples are text PDFs", () => {
    expect(makePdf([["1", "X-1"]]).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(blankPdf().toString("latin1")).not.toMatch(/Tj/);
    if (hasSamples) Object.keys(SAMPLES).forEach((k) => expect(sample(k).subarray(0, 5).toString("latin1")).toBe("%PDF-"));
  });
}

module.exports = { makePdf, blankPdf, xlsxPo, SAMPLES, hasSamples, hasSample, sample, BRADY };
