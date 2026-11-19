// Round 29 — UNIT tests (no DB, no network):
//   S4 every validator with good + bad values (poValidation.js)
//   S1 series name cleaning, case-insensitive reuse, sheet name → series,
//      default series resolution (M210 present / missing → All)
//   S2 action icon rules: status × permission × has-proforma (poActions.js)
//   S3 customer-PO reader: the 3 sample PDFs → lines (catalog, qty, rate),
//      Excel PO, image / scanned PDF → "can't read", unknown catalog → red,
//      obsolete → replacement, qty unreadable → amber, empty / .exe files
//   Totals: taxable = Σ qty × whole-rupee cost, CGST/SGST vs IGST, grand
//      total, margin — the numbers the frontend poCalc test also asserts.
const V = require("../../services/poValidation");
const ACT = require("../../services/poActions");
const RD = require("../../services/customerPoReader");
const { evaluatePo, costOf } = require("../../services/purchaseOrderRules");
const FX = require("./r29Fixtures.cjs");

const err = (r) => r.error || "";
const sampleTest = FX.hasSamples ? test : test.skip;

describe("S4 validators — good and bad values", () => {
  test.each([
    ["M7-84-499", ""], ["m7-84-499", ""], [" M21-500-423 ", ""], ["M4-7-595/0.5in", ""], ["AB", ""], ["X".repeat(40), ""],
    ["", "Catalog no. is required"], ["A", "Catalog no. must be 2 to 40 characters"], ["X".repeat(41), "Catalog no. must be 2 to 40 characters"],
    ["M7 84", "Catalog no. can only have letters, digits and - / . _ (no spaces)"], ["-AB", "Catalog no. can only have letters, digits and - / . _ (no spaces)"],
    ["M7#1", "Catalog no. can only have letters, digits and - / . _ (no spaces)"],
  ])("catalogNo(%j) -> %j", (v, msg) => expect(err(V.catalogNo(v))).toBe(msg));
  test("catalogNo stores as typed (trimmed)", () => expect(V.catalogNo(" m7-84-499 ").value).toBe("m7-84-499"));

  test.each([
    ["Y5075406", ""], ["y5075406", ""], ["Y12345", ""], ["Y123456789", ""], ["", ""],
    ["Y1234", "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)"], ["Y1234567890", "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)"],
    ["5075406", "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)"], ["YABCDE", "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)"],
  ])("yCode(%j) -> %j", (v, msg) => expect(err(V.yCode(v))).toBe(msg));
  test("yCode upper-cases", () => expect(V.yCode("y5075406").value).toBe("Y5075406"));

  const PHONE = "Phone: Enter a 10-digit mobile (starting 6-9, +91 / 0 allowed) or a landline with STD code";
  test.each([
    ["9876543210", ""], ["+91 98765 43210", ""], ["+919876543210", ""], ["09876543210", ""], ["6000000000", ""],
    ["079-26581234", ""], ["022 2658 1234", ""], ["+91 79 0000 0000", ""], ["", ""],
    ["12345", PHONE], ["5876543210", PHONE], ["abc", PHONE], ["98765-4321a", PHONE], ["0123", PHONE], ["+1 202 555 0100", PHONE],
  ])("phone(%j) -> %j", (v, msg) => expect(err(V.phone(v))).toBe(msg));

  test.each([
    ["24ABCDE1234F1Z5", ""], ["24abcde1234f1z5", ""], ["38ABCDE1234F1Z5", ""], ["01ABCDE1234FAZ5", ""], ["", ""],
    ["99ABCDE1234F1Z5", "GSTIN: state code 99 is not valid (01-38)"], ["00ABCDE1234F1Z5", "GSTIN: state code 00 is not valid (01-38)"],
    ["24ABCDE1234F1Z", "GSTIN must be 15 characters like 24ABCDE1234F1Z5"], ["24ABCDE1234F0Z5", "GSTIN must be 15 characters like 24ABCDE1234F1Z5"],
    ["24ABCDE1234F1X5", "GSTIN must be 15 characters like 24ABCDE1234F1Z5"], ["not-a-gstin", "GSTIN must be 15 characters like 24ABCDE1234F1Z5"],
  ])("gstin(%j) -> %j", (v, msg) => expect(err(V.gstin(v))).toBe(msg));
  test("gstin upper-cases lower-case input", () => expect(V.gstin("24abcde1234f1z5").value).toBe("24ABCDE1234F1Z5"));

  test.each([
    ["SGE/PO/2026/145", ""], ["OSI/PO/26-27/052", ""], ["PO (rev 2)", ""], ["ACME_PO.7", ""], ["", ""],
    ["<b>x</b>", "Customer PO No. can only have letters, digits, space and - _ . ( ) /"], ["PO#12", "Customer PO No. can only have letters, digits, space and - _ . ( ) /"],
    ["A".repeat(61), "Customer PO No. can't be longer than 60 characters"],
  ])("customerPoNo(%j) -> %j", (v, msg) => expect(err(V.customerPoNo(v))).toBe(msg));
  test("customerPoNo required when the file is attached", () => {
    expect(err(V.customerPoNo("", { required: true }))).toBe("Customer PO No. is required when the customer's PO file is attached");
  });

  test.each([
    ["DA", ""], ["SPK-PPO", ""], ["ABCDEFGHIJ", ""],
    ["", "PO number prefix is required"], ["DA/1", 'PO number prefix: 1 to 10 letters, digits or - (no "/" or spaces)'],
    ["D A", 'PO number prefix: 1 to 10 letters, digits or - (no "/" or spaces)'], ["ABCDEFGHIJK", 'PO number prefix: 1 to 10 letters, digits or - (no "/" or spaces)'],
  ])("poPrefix(%j) -> %j", (v, msg) => expect(err(V.poPrefix(v))).toBe(msg));

  test.each([["a@b.co", ""], ["po@brady.test", ""], ["", ""], ["a@b", "Email is not a valid email address"], ["a b@c.com", "Email is not a valid email address"], ["not an email", "Email is not a valid email address"]])(
    "email(%j) -> %j", (v, msg) => expect(err(V.email(v))).toBe(msg));
  test.each([["3919", ""], ["391990", ""], ["39199090", ""], ["", ""], ["39199", "HSN/SAC must be 4, 6 or 8 digits"], ["abcd", "HSN/SAC must be 4, 6 or 8 digits"], ["391990901", "HSN/SAC must be 4, 6 or 8 digits"]])(
    "hsn(%j) -> %j", (v, msg) => expect(err(V.hsn(v))).toBe(msg));
  test("GST %: 0/5/12/18/28/40 fine; 23 warned, not blocked", () => {
    [0, 5, 12, 18, 28, 40].forEach((r) => expect(V.gstWarning(r)).toBeNull());
    expect(V.gstWarning(23)).toBe("GST % 23 is not a usual GST rate (0, 5, 12, 18, 28 or 40)");
  });
  test.each([
    [1, ""], [100000, ""], ["7", ""],
    [0, "Quantity must be more than 0"], [-1, "Quantity must be more than 0"], [1.5, "Quantity must be a whole number"],
    ["abc", "Quantity: enter a number"], ["", "Quantity: enter a number"], [100001, "Quantity can't be more than 1,00,000"],
  ])("quantity(%j) -> %j", (v, msg) => expect(err(V.quantity(v))).toBe(msg));
  test.each([
    [0, ""], [10000000, ""], [12.34, ""], ["5000.50", ""],
    [-1, "Price can't be negative"], ["abc", "Price: enter a number"], [1e12, "Price can't be more than 1,00,00,000"], [1.005, "Price: at most 2 decimals"],
  ])("price(%j) -> %j", (v, msg) => expect(err(V.price(v))).toBe(msg));
  test.each([[0, ""], [100, ""], [101, "Disc % must be from 0 to 100"], [-1, "Disc % must be from 0 to 100"], ["x", "Disc %: enter a number"]])(
    "percent(%j) -> %j", (v, msg) => expect(err(V.percent(v))).toBe(msg));
  test.each([[1, ""], [365, ""], ["05", ""], [0, "Valid for (days) must be a whole number from 1 to 365"], [400, "Valid for (days) must be a whole number from 1 to 365"],
    [1.5, "Valid for (days) must be a whole number from 1 to 365"], ["abc", "Valid for (days) must be a whole number from 1 to 365"]])(
    "validDays(%j) -> %j", (v, msg) => expect(err(V.validDays(v))).toBe(msg));
  test("validDays('05') is the number 5 (S5 bug)", () => expect(V.validDays("05").value).toBe(5));
  test("dates: expected >= PO date; customer PO date <= PO date (same day fine)", () => {
    expect(V.poDates({ po_date: "2026-10-27", expected_date: "2026-10-26" })).toEqual([{ field: "expected_date", message: "Expected delivery can't be before the PO date" }]);
    expect(V.poDates({ po_date: "2026-10-27", expected_date: "2026-10-27", customer_po_date: "2026-10-27" })).toEqual([]);
    expect(V.poDates({ po_date: "2026-10-27", customer_po_date: "2026-10-28" })).toEqual([{ field: "customer_po_date", message: "Customer PO date can't be after the PO date" }]);
  });
});

describe("S1 series", () => {
  test("series name: trimmed, spaces collapsed, 1-40 letters/digits/space/-/_", () => {
    expect(V.seriesName(" BMP71  M710 ").value).toBe("BMP71 M710");
    expect(V.seriesName("M210").value).toBe("M210");
    expect(err(V.seriesName(""))).toBe("Series is required");
    expect(err(V.seriesName("PMK&BBP"))).toBe("Series name: 1 to 40 letters, digits, spaces, - or _");
    expect(err(V.seriesName("X".repeat(41)))).toBe("Series name: 1 to 40 letters, digits, spaces, - or _");
  });
  test("a duplicate name in another case reuses the existing series", () => {
    expect(V.reuseSeries("m210", ["M210", "BMP41"])).toBe("M210");
    expect(V.reuseSeries("New One", ["M210"])).toBe("New One");
  });
  test("sheet name -> series: invalid characters become '-', spaces collapsed", () => {
    expect(V.seriesFromSheet("PMK&BBP85_30.03.2026")).toBe("PMK-BBP85_30-03-2026");
    expect(V.seriesFromSheet("BMP71  M710")).toBe("BMP71 M710");
    expect(V.seriesFromSheet("M210")).toBe("M210");
    expect(V.seriesFromSheet("&&&")).toBe("Series");
  });
  test("default series: M210 present -> M210; missing / no items -> '' (All series); any case", () => {
    const { resolveDefaultSeries } = require("../../controllers/purchase_order_controller");
    expect(resolveDefaultSeries("M210", [{ name: "M210", count: 77 }, { name: "BMP41", count: 110 }])).toBe("M210");
    expect(resolveDefaultSeries("m210", [{ name: "M210", count: 77 }])).toBe("M210");
    expect(resolveDefaultSeries("M210", [{ name: "BMP41", count: 110 }])).toBe("");
    expect(resolveDefaultSeries("", [{ name: "M210", count: 77 }])).toBe("");
  });
});

describe("S2 action icon rules (status × permission × has-proforma)", () => {
  const STATUSES = ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "cancelled"];
  const EDIT = { draft: null, pending_approval: "Pending POs are locked", approved: "Approved POs are locked", sent: "Approved POs are locked", partially_received: "Approved POs are locked", received: "Approved POs are locked", cancelled: "Cancelled POs are locked" };
  test.each(STATUSES)("status %s", (status) => {
    const full = ACT.rowActions({ status, type: "purchase" }, { canEdit: true, canDelete: true, hasProforma: false });
    expect(full.view).toEqual({ enabled: true, reason: null });
    expect(full.edit.reason).toBe(EDIT[status]);
    expect(full.delete.reason).toBe(["draft", "cancelled"].includes(status) ? null : EDIT[status]);
    const withPf = ACT.rowActions({ status }, { canEdit: true, canDelete: true, hasProforma: true });
    // round 30: a locked PO with a proforma says both (status first)
    expect(withPf.delete.reason).toBe(["draft", "cancelled"].includes(status) ? "Has a proforma invoice" : `${EDIT[status]} · has a proforma invoice`);
    const noPerm = ACT.rowActions({ status }, { canEdit: false, canDelete: false, hasProforma: false });
    expect(noPerm.edit).toEqual({ enabled: false, reason: "No permission" });
    expect(noPerm.delete).toEqual({ enabled: false, reason: "No permission" });
  });
  test("old Sales PO: edit says read-only", () => expect(ACT.editBlock({ type: "sales", status: "draft" }, { canEdit: true })).toBe("Old Sales POs are read-only"));
});

describe("S3 customer-PO reader", () => {
  const items = FX.BRADY.map((b, i) => ({ _id: `id${i}`, name: b.item_code, active: true, ...b }));
  const read = async (buf, name = "po.pdf") => {
    const { rows } = await RD.readCustomerPoFile(buf, name);
    return RD.matchLines(rows, items);
  };
  const simple = (lines) => lines.map((l) => [l.status, l.item_code || l.catalog, l.qty, l.rate]);

  (FX.hasSample("crystal") ? test : test.skip)("Crystal Bunglows (F1 layout): M7-84-499 ×2 @5000, M21-500-423 ×5 @3000; PO no. + date", async () => {
    const r = await read(FX.sample("crystal"));
    expect(simple(r.lines)).toEqual([["matched", "M7-84-499", 2, 5000], ["matched", "M21-500-423", 5, 3000]]);
    expect(r.customer_po_number).toBe("SGE/PO/2026/145");
    expect(r.customer_po_date).toBe("2026-10-25");
  });
  sampleTest("Om Sai Infra (F1 layout, 3 lines incl. the replacement M7-R4300)", async () => {
    const r = await read(FX.sample("omsai"));
    expect(simple(r.lines)).toEqual([["matched", "M7-R4300", 3, 3000], ["matched", "M21-750-423", 4, 3200], ["matched", "M21-375-423", 6, 3000]]);
    expect(r.customer_po_number).toBe("OSI/PO/26-27/052");
    expect(r.customer_po_date).toBe("2026-10-26");
  });
  sampleTest("SGE (own layout, HSN column before qty)", async () => {
    const r = await read(FX.sample("sge"));
    expect(simple(r.lines)).toEqual([["matched", "M7-84-499", 2, 5000], ["matched", "M21-500-423", 5, 3000]]);
    expect(r.customer_po_number).toBe("SGE/PO/2026/145");
    expect(r.customer_po_date).toBe("2026-10-25");
  });
  test("Excel (.xlsx) customer PO: header + lines, a Y code row, an unknown catalog (red)", async () => {
    const buf = FX.xlsxPo([
      ["PO No.", "XL-PO-9", "", "PO Date", "20/10/2026"],
      ["Sr", "Catalog", "Description", "Qty", "Rate", "Amount"],
      [1, "m21-750-423", "cart", 2, 3100, 6200],
      [2, "Y4900609", "by Y code", 3, 2800, 8400],
      [3, "ZZ-404-1", "not ours", 1, 50, 50],
    ]);
    const r = await read(buf, "po.xlsx");
    expect(simple(r.lines)).toEqual([["matched", "M21-750-423", 2, 3100], ["matched", "M21-375-423", 3, 2800], ["not_found", "ZZ-404-1", undefined, undefined]]);
    expect(r.lines[1].note).toBe("found by Y code Y4900609");
    expect(r.customer_po_number).toBe("XL-PO-9");
    expect(r.customer_po_date).toBe("2026-10-20");
  });
  test("obsolete catalog -> the item that replaces it; obsolete ITEM -> its replacement", async () => {
    const r = await read(FX.makePdf([["1", "M71-R4300", "old ribbon", "2", "Nos", "2,000.00", "4,000.00"]]));
    expect(simple(r.lines)).toEqual([["matched", "M7-R4300", 2, 2000]]);
    expect(r.lines[0].note).toBe("M71-R4300 is obsolete — replaced by M7-R4300");
    const withOld = [...items, { _id: "old", item_code: "OLD-1", name: "OLD-1", replaced_by: "M7-R4300", active: true }];
    const { rows } = await RD.readCustomerPoFile(FX.makePdf([["1", "OLD-1", "3", "100.00", "300.00"]]), "x.pdf");
    const m = RD.matchLines(rows, withOld);
    expect(m.lines[0]).toMatchObject({ status: "matched", item_code: "M7-R4300", qty: 3, note: "OLD-1 is obsolete — replaced by M7-R4300" });
  });
  test("qty unreadable -> amber; same item twice -> merged (qty added); unknown code -> red with the text read", async () => {
    const r = await read(FX.makePdf([
      ["1", "M21-500-423", "cart", "", "Nos", "", ""],
      ["2", "M7-84-499", "label", "2", "Nos", "5,000.00", "10,000.00"],
      ["3", "M7-84-499", "label again", "1", "Nos", "5,000.00", "5,000.00"],
      ["4", "AB-123-X", "unknown", "4", "Nos", "10.00", "40.00"],
    ]));
    expect(r.lines.map((l) => l.status)).toEqual(["qty_unreadable", "matched", "not_found"]);
    expect(r.lines[1]).toMatchObject({ item_code: "M7-84-499", qty: 3 });
    expect(r.lines[1].note).toMatch(/qty added/);
    expect(r.lines[2]).toMatchObject({ catalog: "AB-123-X", note: "Not in PO Items" });
    expect(r.lines[2].text).toContain("AB-123-X");
  });
  test("a PDF with no known catalogs -> no lines", async () => {
    const r = await read(FX.makePdf([["Sr", "Item", "Qty"], ["1", "Some text", "2"]]));
    expect(r.lines).toEqual([]);
  });
  test.each([
    ["image (PNG)", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "scan.png", "Can't read a scanned file — add items by hand"],
    ["image (JPG)", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "scan.jpg", "Can't read a scanned file — add items by hand"],
    ["0-byte file", Buffer.alloc(0), "empty.pdf", "The file is empty"],
    [".exe renamed .pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), "po.pdf", "Only a PDF or Excel (.xlsx) customer PO can be read"],
    ["text file", Buffer.from("hello"), "po.txt", "Only a PDF or Excel (.xlsx) customer PO can be read"],
  ])("%s -> %s", async (_label, buf, name, msg) => {
    await expect(RD.readCustomerPoFile(buf, name)).rejects.toMatchObject({ status: 400, message: msg });
  });
  test("scanned PDF (no text layer) -> 'Can't read a scanned file'", async () => {
    await expect(RD.readCustomerPoFile(FX.blankPdf(), "scan.pdf")).rejects.toMatchObject({ status: 400, message: "Can't read a scanned file — add items by hand" });
  });
  test("a broken PDF -> clear message", async () => {
    await expect(RD.readCustomerPoFile(Buffer.from("%PDF-1.4\nnot really a pdf"), "x.pdf")).rejects.toMatchObject({ status: 400 });
  });
  test("number parsing: Indian / plain / ₹ amounts; '18%' and Y codes are not numbers for qty", () => {
    expect(RD.parseNum("1,20,000.50")).toBe(120000.5);
    expect(RD.parseNum("₹ 3,000")).toBe(3000);
    expect(RD.parseNum("5,000.00")).toBe(5000);
    expect(RD.parseNum("abc")).toBeNull();
    expect(RD.qtyAndRate(["Y5075406", "", "2", "Nos", "5,000.00", "10,000.00", "18%"], 0)).toEqual({ qty: 2, rate: 5000 });
    expect(RD.qtyAndRate(["39199090", "2", "EA", "5,000.00", "10,000.00"], 0)).toEqual({ qty: 2, rate: 5000 });
  });
});

describe("Totals (Crystal Bunglows sample) — same numbers as the frontend poCalc test", () => {
  const rule = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: 13, allow_below_list: false, price_floor: true };
  const line = (code, qty, selling) => {
    const it = FX.BRADY.find((b) => b.item_code === code);
    return { name: code, qty, ...costOf(it), list_price: it.end_customer_price, selling_price: selling, tax_rate: 18 };
  };
  test("taxable = Σ qty × whole-rupee cost; CGST+SGST; grand total; margin ≈ 36 %", () => {
    const r = evaluatePo({ lines: [line("M7-84-499", 2, 5000), line("M21-500-423", 5, 3000)], type: "purchase", taxMode: "intra", rule });
    expect(r.lines.map((l) => [l.rate, l.amount])).toEqual([[3207, 6414], [1914, 9570]]);
    expect(r.totals).toMatchObject({ subtotal: 15984, cgst: 1438.56, sgst: 1438.56, igst: 0, tax_total: 2877.12, grand_total: 18861.12, sell_value: 25000, cost_value: 15986.94, margin_pct: 36.05, margin_amount: 9013.06 });
  });
  test("IGST (other state): same total, all as IGST", () => {
    const r = evaluatePo({ lines: [line("M7-84-499", 2, 5000), line("M21-500-423", 5, 3000)], type: "purchase", taxMode: "inter", rule });
    expect(r.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 2877.12, grand_total: 18861.12 });
  });
});
