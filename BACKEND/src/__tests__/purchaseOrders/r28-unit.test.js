// Round 28 (Brady flow) — UNIT tests, pure functions only (no DB):
//   R3  header detection + synonym mapping for every F2 header style, skipped
//       sheets, HX sheet, price parsing, duplicates by sheet priority,
//       replacement links
//   R2  PO number "<prefix>/<nn>/<FY>": 31 Mar vs 1 Apr, 99 -> 100
//   R6  margin % and ₹, floor (= EP ok, EP - 0.01 error, raise -> reason), Q1 cost
//   R5  proforma maths = the client's sheet formulas, amount in words
const PL = require("../../services/poPriceList");
const rules = require("../../services/purchaseOrderRules");
const PM = require("../../services/proformaMath");
const FX = require("./priceListFixtures.cjs");

const sheet = (name) => FX.rowsOf(FX.workbookBuffer(FX.STYLES.filter((s) => s[0] === name)))[0];
const fieldsOf = (d) => Object.fromEntries(d.columns.filter((c) => c.field !== "ignore").map((c) => [c.header.replace(/\s+/g, " ").trim(), c.field]));

describe("R3 UNIT — header detection + mapping, one fixture per F2 header style", () => {
  // Expected field of the key columns, per style.
  const EXPECT = {
    M210: { header_row: 0, catalog: "Catalog No", y_code: "Y code", master_price: "Master Price (Basic Price/ST Extra)", distributor_price: "Distributor Price (Basic Price/ST Extra)", end_customer_price: "End User Price (Basic Price/ST Extra)", lead_time: "Lead Time", description: "Material Description" },
    BMP41: { header_row: 0, catalog: "Catalog No", y_code: "Y Code", master_price: "Master Distributor Price / UoM ( Basic Price / GST Extra", distributor_price: "DPUser Price (Basic Price/GST Extra)", end_customer_price: "End User Price (Basic Price/GST Extra)" },
    M410: { header_row: 0, catalog: "Catalog", y_code: "Y Code", master_price: "MDP ( INR / UOM)", distributor_price: "DP [ INR/UoM]", end_customer_price: "EP [ INR/UoM]", hsn: "HSN", unit: "UoM" },
    M511: { header_row: 0, catalog: "Catalog No", y_code: "Y CODE", master_price: "MDP(INR/Uom)", distributor_price: "DP(INR/Uom)", end_customer_price: "EP ( INR/UoM)", lead_time: "Column1", remarks: "Column2" },
    M611: { header_row: 1, catalog: "CATALOG NUMBER", y_code: "Y NUMBER", master_price: "Master Distributor Price (Basic Price/ST Extra)", unit: "UOM" },
    "New Replacement Part M611 M710": { header_row: 0, catalog: "New/Replacement Brady Catalog Number", y_code: "New Brady Ynumber (Internal Use Only)", obsolete_catalog: "Existing Obsolete Catalog Number", obsolete_y_code: "Existing Obsolete Brady Ynumber (Internal Use Only)", master_price: "Master Distributor Price (Basic Price/ST Extra)" },
    "BMP71  M710": { header_row: 0, catalog: "CATALOG NUMBER", y_code: "Y958908", master_price: "Master Distributor Price (Basic Price/ST Extra)" },
    J7300: { header_row: 0, catalog: "Catalog", y_code: "Y Code", distributor_price: "DP ( INR / UoM)", end_customer_price: "EP ( INR/UoM)" },
    "HX SERIES SLEEVES": { header_row: 0, catalog: "Material Description", y_code: "Material", distributor_price: "DP ( INR/UoM", end_customer_price: "EP ( INR/UoM)" },
    BBP30_31_33_35_37: { header_row: 0, catalog: "CATALOG NUMBER", y_code: "Y NUMBER", distributor_price: "Distributor Price (Basic Price/ST Extra)" },
    "PMK&BBP85_30.03.2026": { header_row: 1, catalog: "Catalog", y_code: "Y CODE", distributor_price: "DP ( INR/UOM)", end_customer_price: "EP ( INR/UOM)" },
    "HMK and MNK": { header_row: 0, catalog: "CATALOG NUMBER", y_code: "Y NUMBER" },
    "Floor and other Tapes": { header_row: 0, catalog: "Catalog No", y_code: "Y CODE", lead_time: "Lead time", remarks: "remarks" },
    "Pipe Marker": { header_row: 0, catalog: "CATALOG NUMBER", y_code: "Y NUMBER" },
    "People ID and Tags": { header_row: 0, catalog: "CATALOG NUMBER" },
    "LOTO Core": { header_row: 0, catalog: "CATALOG NUMBER", distributor_price: "Distributor Price (Basic Price/ST Extra)" },
    "Loto Non Core": { header_row: 0, catalog: "CATALOG NUMBER", y_code: "Y NUMBER" },
    Sorbent: { header_row: 0, lead_time: "Lead Tine" },
    LOTO: { header_row: 0, catalog: "CATALOG NUMBER", lead_time: "Lead Tine" },
    M610: { header_row: 0, catalog: "Catalog No", master_price: "Master Distributor Price (Basic Price/ST Extra)" },
  };
  test.each(Object.keys(EXPECT))("%s", (name) => {
    const s = sheet(name);
    const d = PL.detectSheet(s.name, s.rows);
    const exp = EXPECT[name];
    expect(d.skip_reason).toBe("");
    expect(d.header_row).toBe(exp.header_row);
    const byField = Object.fromEntries(d.columns.map((c) => [c.field, c.header.replace(/\s+/g, " ").trim()]));
    for (const [field, header] of Object.entries(exp)) {
      if (field === "header_row") continue;
      expect([field, byField[field]]).toEqual([field, header.replace(/\s+/g, " ").trim()]);
    }
    expect(d.item_rows).toBeGreaterThan(0);
  });

  test("Codesoft (software price grid) is skipped with a clear reason", () => {
    const s = sheet("Codesoft");
    const d = PL.detectSheet(s.name, s.rows);
    expect(d.skip_reason).toBe("No catalog, Y code or price columns found — not an item list");
    expect(d.header_row).toBe(-1);
  });
  test("empty sheet / headerless numbers / a key but no price / prices but no key -> skipped with the reason", () => {
    expect(PL.detectSheet("Empty", []).skip_reason).toBe("Empty sheet");
    expect(PL.detectSheet("Blank", [[], [null, ""]]).skip_reason).toBe("Empty sheet");
    expect(PL.detectSheet("Numbers", [[1, 2, 3], [4, 5, 6]]).skip_reason).toMatch(/not an item list/);
    expect(PL.detectSheet("NoPrice", [["Catalog No", "Y Code", "Description"], ["A-1", "Y1234567", "x"]]).skip_reason).toBe("No price column found");
    expect(PL.detectSheet("NoKey", [["Description", "MDP", "DP", "EP"], ["x", 1, 2, 3]]).skip_reason).toBe("No catalog or Y code column found");
    expect(PL.detectSheet("HeaderOnly", [["Catalog No", "MDP", "DP"]]).skip_reason).toBe("No item rows under the header");
  });
  test("HX sheet: Y code in 'Material' (by its contents), catalog in 'Material Description' (codes only)", () => {
    const s = sheet("HX SERIES SLEEVES");
    const d = PL.detectSheet(s.name, s.rows);
    const { records } = PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field));
    expect(records[0]).toMatchObject({ item_code: "FX-HX-094-2", y_code: "Y9000701", distributor_price: 34002, end_customer_price: 39102, unit: "ROL", lead_time: "8-10 weeks" });
    expect(records[0].master_price).toBeUndefined(); // no MDP on this sheet (Q1: cost from DP)
  });
  test("a 'Material' column of material names stays an attribute (M210)", () => {
    const s = sheet("M210");
    const d = PL.detectSheet(s.name, s.rows);
    expect(fieldsOf(d).Material).toBe("attribute");
    const { records } = PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field));
    expect(records[0].attributes).toMatchObject({ Material: "Polyolefin", Color: "BLACK ON WHITE", "B No": "B-342", "Label Width Inch(mm)": "1.25(25.40)" });
  });
  test("BMP71: the 2nd 'CATALOG NUMBER' column is an attribute, 'Y958908' title = Y code", () => {
    const s = sheet("BMP71  M710");
    const d = PL.detectSheet(s.name, s.rows);
    expect(d.columns.map((c) => c.field).slice(0, 4)).toEqual(["attribute", "catalog", "y_code", "attribute"]);
  });
  test("M610: the header repeated lower down (with other extra columns) is not an item row", () => {
    const s = sheet("M610");
    const d = PL.detectSheet(s.name, s.rows);
    const { records, blank } = PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field));
    expect(records.map((r) => r.item_code)).toEqual(["FX-BMP-1", "FX-BMP-2"]);
    expect(records.every((r) => !r.error)).toBe(true);
    expect(blank).toBe(1);
  });
  test("numbers as catalog are text; 'NA' catalog falls back to the Y code; 'Not got' is no Y code", () => {
    const lotoS = sheet("LOTO");
    const d = PL.detectSheet(lotoS.name, lotoS.rows);
    const { records } = PL.extractRows(lotoS.name, lotoS.rows, d.header_row, d.columns.map((c) => c.field));
    expect(records.map((r) => [r.item_code, r.y_code, r.key])).toEqual([["", "Y9001601", "y9001601"], ["9065318", "Y9001602", "9065318"]]);
    const nc = sheet("Loto Non Core");
    const d2 = PL.detectSheet(nc.name, nc.rows);
    expect(PL.extractRows(nc.name, nc.rows, d2.header_row, d2.columns.map((c) => c.field)).records[0]).toMatchObject({ item_code: "9143150", y_code: "" });
  });
  test("the header signature is stable and a saved mapping is applied (remembered)", () => {
    const s = sheet("M410");
    const d = PL.detectSheet(s.name, s.rows);
    expect(d.signature).toBe(PL.signatureOf(s.rows[0]));
    expect(d.remembered).toBe(false);
    const fields = Object.fromEntries(d.columns.map((c) => [String(c.index), c.field]));
    fields["1"] = "attribute"; // the user changed "Description" to an extra detail
    const again = PL.detectSheet(s.name, s.rows, [{ signature: d.signature, fields }]);
    expect(again.remembered).toBe(true);
    expect(again.columns[1]).toMatchObject({ field: "attribute", auto_field: "description" });
  });
});

describe("R3 UNIT — price parsing", () => {
  test("long decimals -> 2 dp; text numbers; blank = not set", () => {
    expect(PL.priceCell(3207.371625312854)).toBe(3207.37);
    expect(PL.priceCell(3690.8764387949986)).toBe(3690.88);
    expect(PL.priceCell(4613.5955484937485)).toBe(4613.6);
    expect(PL.priceCell("1,250.505")).toBe(1250.51);
    expect(PL.priceCell("₹ 99")).toBe(99);
    expect(PL.priceCell(null)).toBeUndefined();
    expect(PL.priceCell("  ")).toBeUndefined();
  });
  test("text in a price cell -> NaN (error row), negative -> NaN", () => {
    expect(Number.isNaN(PL.priceCell("Ask for Price"))).toBe(true);
    expect(Number.isNaN(PL.priceCell(-5))).toBe(true);
    expect(Number.isNaN(PL.priceCell("12abc"))).toBe(true);
  });
  test("a row with text in a price column is an error row; a blank DP/MDP is just not set", () => {
    const s = sheet("LOTO Core");
    const d = PL.detectSheet(s.name, s.rows);
    const { records } = PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field));
    expect(records[0]).toMatchObject({ item_code: "9051339", distributor_price: 5482.65, end_customer_price: 6853.31 });
    expect(records[0].master_price).toBeUndefined();
    expect(records[1].error).toBe('Distributor Price is not a number ("Ask for Price"); End User Price is not a number ("Ask for Price")');
  });
  test("GST % cell: 18 / '18%' / 0.18 -> 18; text -> error", () => {
    expect(PL.gstCell(18)).toBe(18);
    expect(PL.gstCell("18%")).toBe(18);
    expect(PL.gstCell(0.18)).toBe(18);
    expect(Number.isNaN(PL.gstCell("eighteen"))).toBe(true);
  });
});

describe("R3 UNIT — duplicates + replacement links", () => {
  const all = () => {
    const out = [];
    for (const s of FX.rowsOf(FX.workbookBuffer())) {
      const d = PL.detectSheet(s.name, s.rows);
      if (d.skip_reason) continue;
      out.push(...PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field)).records);
    }
    return out;
  };
  const names = FX.STYLES.map((s) => s[0]);
  test("Q5 default priority: 'New Replacement Part…' first, then the file order", () => {
    expect(PL.defaultPriority(names)[0]).toBe("New Replacement Part M611 M710");
    expect(PL.defaultPriority(names).slice(1)).toEqual(names.filter((n) => !/New Replacement/.test(n)));
  });
  test("the same catalog on two sheets -> one item; the priority sheet wins; both prices listed", () => {
    const res = PL.resolveDuplicates(all(), PL.defaultPriority(names));
    const win = res.winners.find((w) => w.item_code === "FX-M7-1");
    expect(win).toMatchObject({ sheet: "New Replacement Part M611 M710", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6 });
    const dup = res.duplicates.find((d) => d.catalog === "FX-M7-1");
    expect(dup.chosen).toBe("New Replacement Part M611 M710");
    expect(dup.options.map((o) => [o.sheet, o.master_price])).toEqual([["New Replacement Part M611 M710", 3207.37], ["BMP71  M710", 2507.53]]);
  });
  test("another priority order / a per-item choice changes the winner", () => {
    const order = ["BMP71  M710", ...PL.defaultPriority(names).filter((n) => n !== "BMP71  M710")];
    expect(PL.resolveDuplicates(all(), order).winners.find((w) => w.item_code === "FX-M7-1").master_price).toBe(2507.53);
    const chosen = PL.resolveDuplicates(all(), PL.defaultPriority(names), { "fx-m7-1": "BMP71  M710" });
    expect(chosen.winners.find((w) => w.item_code === "FX-M7-1").sheet).toBe("BMP71  M710");
    expect(chosen.duplicates.find((d) => d.catalog === "FX-M7-1").chosen).toBe("BMP71  M710");
  });
  test("duplicate rows inside ONE sheet -> the later row is an error", () => {
    const rows = [["Catalog No", "MDP", "DP", "EP"], ["D-1", 1, 2, 3], ["d-1", 4, 5, 6], ["D-2", 1, 2, 3]];
    const d = PL.detectSheet("Dups", rows);
    const { records } = PL.extractRows("Dups", rows, d.header_row, d.columns.map((c) => c.field));
    const res = PL.resolveDuplicates(records, ["Dups"]);
    expect(res.winners.map((w) => [w.item_code, w.master_price])).toEqual([["D-1", 1], ["D-2", 1]]);
    expect(res.errors).toEqual([expect.objectContaining({ row: 3, error: "Same catalog as row 2 of this sheet" })]);
  });
  test("replacement links: obsolete -> new catalog kept on the new item (replaces) and as a link", () => {
    const res = PL.resolveDuplicates(all(), PL.defaultPriority(names));
    expect(res.winners.find((w) => w.item_code === "FX-M7-1").replaces).toEqual(["FX-OLD-7", "Y8000001"]);
    expect(res.links).toEqual([{ old_catalog: "FX-OLD-7", new_catalog: "FX-M7-1" }]);
    // the obsolete catalog also exists as its own item (BMP71 sheet) — it stays an item
    expect(res.winners.find((w) => w.item_code === "FX-OLD-7")).toBeDefined();
  });
  test("cleanSheets: refuses non-arrays, duplicate names, too many rows", () => {
    expect(PL.cleanSheets(undefined).error).toBe("The workbook has no sheets");
    expect(PL.cleanSheets([{ name: "A", rows: [] }, { name: "A", rows: [] }]).error).toMatch(/listed twice/);
    expect(PL.cleanSheets([{ name: "A", rows: "x" }]).error).toMatch(/rows missing/);
    expect(PL.cleanSheets([{ name: "A", rows: Array(20001).fill([]) }]).error).toMatch(/more than 20000 rows/);
    expect(PL.cleanSheets([{ name: " A ", rows: [[{ $gt: 1 }, "x".repeat(900)]] }]).sheets[0].rows[0]).toEqual(["[object Object]", "x".repeat(500)]);
  });
});

describe("R2 UNIT — PO number <prefix>/<nn>/<FY>", () => {
  test("FY runs April–March in India time: 31 Mar vs 1 Apr", () => {
    expect(rules.fyOf("2027-03-31T12:00:00+05:30")).toBe("26-27");
    expect(rules.fyOf("2027-04-01T00:30:00+05:30")).toBe("27-28");
    // 31 Mar 19:00 UTC is already 1 Apr 00:30 in India
    expect(rules.fyOf("2027-03-31T19:00:00Z")).toBe("27-28");
    expect(rules.fyOf("2026-04-01")).toBe("26-27");
    expect(rules.fyOf("2099-12-31")).toBe("99-00");
    expect(rules.fyOf("abc")).toBeNull();
  });
  test("running number 2+ digits: 7 -> 07, 99 -> 99, 100 -> 100", () => {
    expect(rules.formatPoNumber("DA", 7, "26-27")).toBe("DA/07/26-27");
    expect(rules.formatPoNumber("DA", 99, "26-27")).toBe("DA/99/26-27");
    expect(rules.formatPoNumber("DA", 100, "26-27")).toBe("DA/100/26-27");
  });
});

describe("R6 UNIT — cost (Q1), margin, floor", () => {
  test("Q1: cost = MDP; no MDP -> DP (flagged); else the old landing cost", () => {
    expect(rules.costOf({ master_price: 3207.37, distributor_price: 3690.88 })).toEqual({ cost_price: 3207.37, cost_source: "mdp" });
    expect(rules.costOf({ master_price: 0, distributor_price: 34002 })).toEqual({ cost_price: 34002, cost_source: "dp" });
    expect(rules.costOf({ cost_price: 50 })).toEqual({ cost_price: 50, cost_source: "landing" });
    expect(rules.costOf({})).toEqual({ cost_price: 0, cost_source: "none" });
  });
  const RULE = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: 13, allow_below_list: false, price_floor: true };
  const line = (selling, extra = {}) => ({ name: "M7", qty: 2, cost_price: 3207.37, list_price: 4613.6, selling_price: selling, tax_rate: 18, cost_source: "mdp", ...extra });
  test("margin % = (selling - cost) / selling; ₹ margin = (selling - cost) x qty; PO rate = cost rounded (Q3)", () => {
    const l = rules.computeLine(line(4613.6), "purchase");
    expect(l.margin_pct).toBe(30.48);
    expect(l.margin_amount).toBe(2812.46);
    expect(l).toMatchObject({ rate: 3207, amount: 6414, tax_amount: 1154.52 });
    const t = rules.computeTotals([l], "inter");
    expect(t).toMatchObject({ subtotal: 6414, igst: 1154.52, grand_total: 7568.52, margin_amount: 2812.46, margin_pct: 30.48 });
  });
  test("floor: selling = EP ok; EP - 0.01 error; raise -> reason for the approver", () => {
    expect(rules.floorError(rules.computeLine(line(4613.6), "purchase"), RULE)).toBeNull();
    expect(rules.floorError(rules.computeLine(line(4613.59), "purchase"), RULE)).toBe("price can't be lower than the price-master price 4613.6");
    expect(rules.lineBreaches(rules.computeLine(line(5000), "purchase"), RULE)).toEqual(["Price raised from 4613.6 to 5000"]);
  });
  test("cost from DP is pointed out to the approver; margin under the minimum too", () => {
    const dp = rules.computeLine(line(39102, { cost_price: 34002, list_price: 39102, cost_source: "dp" }), "purchase");
    expect(rules.lineBreaches(dp, RULE)).toEqual(["Cost from DP (no Master Distributor Price)"]);
    const low = rules.computeLine(line(4613.6, { cost_price: 4500 }), "purchase");
    expect(rules.lineBreaches(low, RULE)).toEqual(["Margin 2.46% is below the 13% minimum"]);
  });
  test("no cost -> margin unknown (null), never 100 %", () => {
    const l = rules.computeLine(line(100, { cost_price: 0 }), "purchase");
    expect(l.margin_pct).toBeNull();
    expect(l.margin_amount).toBeNull();
    expect(rules.computeTotals([l]).margin_amount).toBeNull();
  });
});

describe("R5 UNIT — proforma maths (the client's sheet formulas) + amount in words", () => {
  const L = (qty, rate, disc, gst, extra = {}) => ({ qty, rate, disc_pct: disc, gst_pct: gst, ...extra });
  test("IGST: line total = taxable + ROUND(taxable x gst, 2); grand = sum; IGST = grand - taxable", () => {
    const r = PM.computeProforma({ lines: [L(1, 3691, 0, 18), L(1, 2151, 0, 18)], taxType: "igst", advance: 0 });
    expect(r.lines.map((l) => [l.taxable, l.total])).toEqual([[3691, 4355.38], [2151, 2538.18]]);
    expect(r.totals).toEqual({ taxable: 5842, cgst: 0, sgst: 0, igst: 1051.56, grand_total: 6893.56, advance: 0, balance: 6893.56 });
  });
  test("CGST + SGST: line total = taxable + 2 x ROUND(taxable x gst / 2, 2); CGST = SGST = half", () => {
    const r = PM.computeProforma({ lines: [L(1, 10.05, 0, 18), L(3, 333.33, 0, 5)], taxType: "cgst_sgst", advance: 0 });
    // 10.05 x 9 % = 0.9045 -> 0.90 (x2 = 1.80, IGST would round 1.809 to 1.81)
    expect(r.lines[0]).toMatchObject({ taxable: 10.05, tax: 1.8, total: 11.85 });
    expect(r.lines[1]).toMatchObject({ taxable: 999.99, tax: 50, total: 1049.99 });
    expect(r.totals).toMatchObject({ taxable: 1010.04, cgst: 25.9, sgst: 25.9, igst: 0, grand_total: 1061.84 });
    const igst = PM.computeProforma({ lines: [L(1, 10.05, 0, 18)], taxType: "igst" });
    expect(igst.lines[0]).toMatchObject({ tax: 1.81, total: 11.86 });
  });
  test("Disc %: taxable = ROUND(qty x rate x (1 - disc), 2)", () => {
    const r = PM.computeProforma({ lines: [L(3, 1000, 10, 18), L(7, 33.33, 12.5, 18)], taxType: "igst" });
    expect(r.lines.map((l) => l.taxable)).toEqual([2700, 204.15]);
  });
  test("freight / packing as a line with its own GST; advance -> balance payable", () => {
    const r = PM.computeProforma({ lines: [L(1, 3691, 0, 18), L(1, 500, 0, 18, { is_extra: true, description: "Freight / packing" })], taxType: "igst", advance: 2000 });
    expect(r.totals).toMatchObject({ taxable: 4191, igst: 754.38, grand_total: 4945.38, advance: 2000, balance: 2945.38 });
  });
  test.each([
    [0, "Zero rupees only."],
    [1, "One rupee only."],
    [999, "Nine hundred ninety nine rupees only."],
    [100000, "One lakh rupees only."],
    [6893.56, "Six thousand eight hundred ninety three rupees and fifty six paisa only."],
    [137540.8, "One lakh thirty seven thousand five hundred forty rupees and eighty paisa only."],
    [10000000, "One crore rupees only."],
    [123456789.01, "Twelve crore thirty four lakh fifty six thousand seven hundred eighty nine rupees and one paisa only."],
  ])("amount in words: %p -> %s", (n, words) => {
    expect(PM.amountInWords(n)).toBe(words);
  });
});
