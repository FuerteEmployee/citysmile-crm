// Round 30 — UNIT tests (no DB, no network):
//   S6 reference helpers: multi-paste parsing, lookup by catalog / Y code /
//      obsolete catalog, entry → PO item values; the duplicate resolver tells
//      which sheets a catalog is on and the sheet its price came from.
//   Fix (MEDIUM): customer-PO reader with a BLANK qty cell — the rate must
//      never become the qty (PDF with a table header, PDF without a header,
//      .xlsx); qty unreadable → amber.
//   Fix (INFO): Delete reason on a locked PO that has a proforma.
const REF = require("../../services/poReference");
const RD = require("../../services/customerPoReader");
const ACT = require("../../services/poActions");
const PL = require("../../services/poPriceList");
const PLFX = require("./priceListFixtures.cjs");
const FX = require("./r29Fixtures.cjs");

describe("S6 multi-paste parsing", () => {
  test("one per line / comma / semicolon / tab; trimmed; quotes dropped; duplicates (any case) once", () => {
    expect(REF.parseCatalogList("M7-84-499\nM21-500-423, Y4900609;\t'M7-R4300'\n m7-84-499 \n\n")).toEqual({ list: ["M7-84-499", "M21-500-423", "Y4900609", "M7-R4300"] });
    expect(REF.parseCatalogList(["A-1", "B-2", 7])).toEqual({ list: ["A-1", "B-2", "7"] });
    expect(REF.parseCatalogList("BMP-41 CART 2IN")).toEqual({ list: ["BMP-41 CART 2IN"] }); // real catalogs can have spaces
  });
  test.each([
    ["", "Type a catalog no. (or Y code / obsolete catalog no.)"],
    [" ,, \n ", "Type a catalog no. (or Y code / obsolete catalog no.)"],
    [null, "Type a catalog no. (or Y code / obsolete catalog no.)"],
    [{ $ne: 1 }, "Type a catalog no. (or Y code / obsolete catalog no.)"],
    [Array.from({ length: 201 }, (_, i) => `C-${i}`).join("\n"), "Paste at most 200 catalog nos. at a time (201 given)"],
    ["X".repeat(101), `"${"X".repeat(20)}…" is too long for a catalog no. (max 100 characters)`],
  ])("bad input %#", (input, error) => expect(REF.parseCatalogList(input)).toEqual({ error }));
  test("exactly 200 is fine", () => expect(REF.parseCatalogList(Array.from({ length: 200 }, (_, i) => `C-${i}`).join(",")).list).toHaveLength(200));
});

describe("S6 lookup", () => {
  const e = (x) => ({ ...x, ...REF.entryKeys(x) });
  const entries = [
    e({ item_code: "M7-84-499", y_code: "Y5075406", replaces: ["M71-84-499", "Y981214"], category: "BMP71 M710" }),
    e({ item_code: "M21-500-423", y_code: "Y4900629", category: "M210" }),
  ];
  test("catalog (any case) → via catalog", () => expect(REF.pickEntry("m7-84-499", entries)).toMatchObject({ via: "catalog", note: "", entry: { item_code: "M7-84-499" } }));
  test("Y code → via y_code with a note", () => expect(REF.pickEntry("y4900629", entries)).toMatchObject({ via: "y_code", note: "found by Y code Y4900629", entry: { item_code: "M21-500-423" } }));
  test("obsolete catalog / Y → the replacement", () => {
    expect(REF.pickEntry("M71-84-499", entries)).toMatchObject({ via: "obsolete", note: "M71-84-499 is obsolete — replaced by M7-84-499" });
    expect(REF.pickEntry("Y981214", entries).entry.item_code).toBe("M7-84-499");
  });
  test("unknown → null", () => expect(REF.pickEntry("ZZ-1", entries)).toBeNull());
  test("entry keys are lower-case", () => expect(REF.entryKeys({ item_code: "AB-1", y_code: "Y12345", replaces: ["OLD-1", ""] })).toEqual({ code_lc: "ab-1", y_lc: "y12345", replaces_lc: ["old-1"] }));
  test("entry → PO item: name = catalog, GST 18 by default, unit Nos, series + price sheet kept", () => {
    expect(REF.itemFromEntry({ item_code: "M7-84-499", y_code: "Y5075406", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, category: "BMP71 M710", price_sheet: "New Replacement Part M611 M710", replaces: ["M71-84-499"], attributes: new Map([["Color", "BLACK"]]) })).toEqual({
      item_code: "M7-84-499", y_code: "Y5075406", name: "M7-84-499", description: "", hsn: "", unit: "Nos", tax_rate: 18,
      master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, lead_time: "", remarks: "",
      category: "BMP71 M710", price_sheet: "New Replacement Part M611 M710", replaces: ["M71-84-499"], attributes: { Color: "BLACK" },
    });
    expect(REF.itemFromEntry({ y_code: "Y9000001", tax_rate: 0 })).toMatchObject({ name: "Y9000001", tax_rate: 0, item_code: undefined });
  });
});

describe("S6 duplicate resolver: sheets per catalog + the price sheet", () => {
  const sheets = PLFX.rowsOf(PLFX.workbookBuffer());
  const all = () => {
    const out = [];
    for (const s of sheets) {
      const d = PL.detectSheet(s.name, s.rows);
      if (d.skip_reason) continue;
      const { records } = PL.extractRows(s.name, s.rows, d.header_row, d.columns.map((c) => c.field));
      records.forEach((r) => { r.category = s.name; });
      out.push(...records);
    }
    return out;
  };
  test("FX-M7-1: on the replacement sheet + BMP71; price from the replacement sheet, series BMP71", () => {
    const names = sheets.map((s) => s.name);
    const res = PL.resolveDuplicates(all(), PL.defaultPriority(names));
    expect(res.sheetsByKey.get("fx-m7-1")).toEqual(["New Replacement Part M611 M710", "BMP71  M710"]);
    expect(res.winners.find((w) => w.item_code === "FX-M7-1")).toMatchObject({ price_sheet: "New Replacement Part M611 M710", category: "BMP71  M710", master_price: 3207.37 });
    expect(res.winners.find((w) => w.item_code === "FX-M21-100").price_sheet).toBe("M210");
  });
});

describe("FIX (MEDIUM): blank Qty cell in the customer PO", () => {
  const items = FX.BRADY.map((b, i) => ({ _id: `id${i}`, name: b.item_code, active: true, ...b }));
  const read = async (buf, name = "po.pdf") => RD.matchLines((await RD.readCustomerPoFile(buf, name)).rows, items).lines.map((l) => [l.status, l.item_code, l.qty, l.rate]);
  const F1_HEAD = ["Sr.", "Item of", "Description", "HSN /", "Qty", "Unit", "Unit rate", "Taxable value", "GST"];

  test("PDF with the F1 header: blank Qty → amber, rate 3000 kept (never qty 3000); the other line unchanged", async () => {
    const lines = await read(FX.makePdf([
      F1_HEAD,
      ["1", "M7-84-499", "Y5075406", "", "2", "Nos", "5,000.00", "10,000.00", "18%"],
      ["2", "M21-500-423", "Y4900629 cart", "", "", "Nos", "3,000.00", "", "18%"],
    ]));
    expect(lines).toEqual([["matched", "M7-84-499", 2, 5000], ["qty_unreadable", "M21-500-423", null, 3000]]);
  });
  test("PDF with the header: qty 3 in the Qty column, Y code + HSN elsewhere → read from the columns", async () => {
    const lines = await read(FX.makePdf([
      ["Sr", "Catalog No.", "Description", "HSN", "Qty", "Unit", "Rate (Rs.)", "Amount (Rs.)"],
      ["1", "M21-750-423", "Y4900648", "39199090", "3", "EA", "3,200.00", "9,600.00"],
    ]));
    expect(lines).toEqual([["matched", "M21-750-423", 3, 3200]]);
  });
  test("PDF without a header: blank qty, rate = amount → amber (the old code read qty 3000)", async () => {
    expect(await read(FX.makePdf([["1", "M21-500-423", "cart", "", "Nos", "3,000.00", "3,000.00"]]))).toEqual([["qty_unreadable", "M21-500-423", null, 3000]]);
  });
  test("PDF without a header: only a rate → amber", async () => {
    expect(await read(FX.makePdf([["1", "M21-500-423", "cart", "", "Nos", "3,000.00", ""]]))).toEqual([["qty_unreadable", "M21-500-423", null, 3000]]);
  });
  test("without a header a normal qty × rate = amount row still reads", async () => {
    expect(await read(FX.makePdf([["1", "M21-500-423", "cart", "4", "Nos", "3,000.00", "12,000.00"]]))).toEqual([["matched", "M21-500-423", 4, 3000]]);
  });
  test(".xlsx: blank Qty cell under the header → amber; the next line reads", async () => {
    const xl = FX.xlsxPo([
      ["Sr", "Catalog", "Qty", "Unit", "Rate", "Amount"],
      [1, "M21-500-423", "", "Nos", 3000, ""],
      [2, "M7-84-499", 2, "Nos", 5000, 10000],
    ]);
    expect(await read(xl, "po.xlsx")).toEqual([["qty_unreadable", "M21-500-423", null, 3000], ["matched", "M7-84-499", 2, 5000]]);
  });
  test(".xlsx: a decimal qty (1.5) is not a PO qty → amber", async () => {
    const xl = FX.xlsxPo([["Catalog", "Qty", "Rate"], ["M7-84-499", 1.5, 5000]]);
    expect(await read(xl, "po.xlsx")).toEqual([["qty_unreadable", "M7-84-499", null, 5000]]);
  });
  test("header detection: needs Qty + Rate/Amount", () => {
    expect(RD.headerColumns(["Sr", "Catalog", "Qty", "Rate"])).toMatchObject({ pdf: false, cols: expect.arrayContaining([{ kind: "qty", pos: 2 }, { kind: "rate", pos: 3 }]) });
    expect(RD.headerColumns(["Sr", "Catalog", "Description"])).toBeNull();
    expect(RD.headerColumns(["Total Qty", "Rate"])).toBeNull();
  });
  test("fallback qtyAndRate: qty equal to a later number is refused", () => {
    expect(RD.qtyAndRate(["3,000.00", "3,000.00"], 0)).toEqual({ qty: null, rate: 3000 });
    expect(RD.qtyAndRate([3000], 0)).toEqual({ qty: null, rate: 3000 });
    expect(RD.qtyAndRate(["2", "Nos", "5,000.00"], 0)).toEqual({ qty: 2, rate: 5000 });
  });
});

describe("FIX (INFO): Delete reason on a locked PO with a proforma", () => {
  test.each([
    ["approved", "Approved POs are locked · has a proforma invoice"],
    ["sent", "Approved POs are locked · has a proforma invoice"],
    ["received", "Approved POs are locked · has a proforma invoice"],
    ["pending_approval", "Pending POs are locked · has a proforma invoice"],
    ["draft", "Has a proforma invoice"],
    ["cancelled", "Has a proforma invoice"],
  ])("%s + proforma → %s", (status, reason) => {
    expect(ACT.deleteBlock({ status }, { canDelete: true, hasProforma: true })).toBe(reason);
  });
  test("without a proforma: unchanged; no permission wins", () => {
    expect(ACT.deleteBlock({ status: "approved" }, { canDelete: true, hasProforma: false })).toBe("Approved POs are locked");
    expect(ACT.deleteBlock({ status: "approved" }, { canDelete: false, hasProforma: true })).toBe("No permission");
  });
});
