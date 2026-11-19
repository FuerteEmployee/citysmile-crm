// Small fixture "workbooks" for the Brady price-list import tests (round 28,
// R3). One sheet per HEADER STYLE found in the client's price list (F2) —
// the column titles are reproduced, the data rows are made up (fake catalog
// numbers and prices; nothing from the client's file). Named .cjs so jest does
// not run it as a suite (poStack.cjs runs a guard test when collected).
//
// rowsOf(workbookBuffer) reads a workbook the same way the browser does
// (CRM-FRONTEND-NEW/src/pages/purchase-orders/priceListFile.ts).
const XLSX = require("xlsx");

const T = "(Basic Price/ST Extra)";
const G = "(Basic Price/GST Extra)";
const r = (n) => Math.round(n * 1e9) / 1e9; // long decimals like the real file

// [sheet name, header rows above the header (spacer rows), header, data rows]
const STYLES = [
  ["M210", [], ["Catalog No", "Y code ", "Material Description", null, "B No", "Material", "Color", "Label Width\r\nInch(mm)", "Roll Length\r\nFt(m)", "Labels per Roll", "Ribbon in Cartridge", `Master Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Remarks ", "Lead Time "],
    [["FX-M21-100", "Y9000001", "CART FX 1IN", "CQ", "B-342", "Polyolefin", "BLACK ON WHITE", "1.25(25.40)", "21 FT", "1 ROLL", "R6200", r(1000.123456789), r(1150.987654321), r(1438.7345)], ["FX-M21-200", "Y9000002", "CART FX 2IN", "EA", "B-423", "Polyester", "WHITE", "0.5", "21 FT", "1 ROLL", "R6200", 2000, 2300, 2875]]],
  ["BMP41", [], ["Catalog No", "Y Code", "Material Description", "B No", "Material", `Master Distributor Price / UoM ( Basic Price / GST Extra`, `DPUser Price ${G}`, `End User Price ${G}`, "Remarks ", "Lead Time "],
    [["FX-M4-1", "Y9000101", "FX-M4-1", "B-427", "Vinyl", 500.555, 575.5, 719.375, "GST EXTRA AS APPLICABLE", "8-10 Weeks"]]],
  ["M410", [], ["Y Code ", "Description", "UoM", "Catalog", "MDP ( INR / UOM)", "DP [ INR/UoM]", "EP [ INR/UoM]", "HSN", "Remarks ", "Lead Time"],
    [["Y9000201", "FX-M4C-1", "CTR", "FX-M4C-1", 4190.361073223325, 4822.049566424999, 6027.561958031249, 84433290, "GST EXTRA AS APPLICABLE", "3-4 MONTHS"]]],
  ["M511", [], ["Y CODE", "Material Description", "MDP(INR/Uom)", "DP(INR/Uom)", "EP ( INR/UoM)", "UoM", "Catalog No", "Column1", "Column2"],
    [["Y9000301", "FX-M5-1", 300, 345, 431.25, "CTR", "FX-M5-1", "Lead Time 8-10 Weeks", "GST Extra As Applicable"], ["Y9000302", "FX-M5-2", 310, 356.5, 445.63, "CTR", "FX-M5-2", "Lead Time 8-10 Weeks", "GST Extra As Applicable"], ["Y9000303", "FX-M5-3", 320, 368, 460, "CTR", "FX-M5-3", "Lead Time 8-10 Weeks", "GST Extra As Applicable"]]],
  ["M611", [[""]], ["Y NUMBER", "CATALOG NUMBER", "Description", "Color", "SALES QTY", "PACKAGE QTY", "UOM", `Master Distributor Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Remarks ", "Lead Time "],
    [["Y9000401", "FX-M6-1", "FX-M6-1", "GREEN/CLEAR", 1, 1, "ROL", 5141.873, 5917, 7396, "GST EXTRA AS APPLICABLE", "8-10 Weeks"]]],
  ["New Replacement Part M611 M710", [], ["Go Live for New Part/Obsolete Date for Existing", "Existing Obsolete Catalog Number", "Existing Obsolete Brady Ynumber (Internal Use Only)", "Replacement Part Available", "New/Replacement Brady Catalog Number", "New Brady Ynumber (Internal Use Only)", `Master Distributor Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Lead Time", "Remarks"],
    [[45022, "FX-OLD-7", "Y8000001", "Yes", "FX-M7-1", "Y9000501", 3207.371625312854, 3690.8764387949986, 4613.5955484937485, "8-10 weeks", "GST EXTRA AS APPLICABLE"], [45022, null, null, "Yes", "FX-M7-2", "Y9000502", 1869.4601243368054, 2151.277473345, 2689.09684168125, "8-10 weeks", "GST EXTRA AS APPLICABLE"]]],
  ["BMP71  M710", [], ["HEADER CODE", "CATALOG NUMBER", "Y958908", "CATALOG NUMBER", "Description", "SALES QTY", "UOM", `Master Distributor Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Lead Time", "Remarks"],
    [["Printer", "FX-M7-1", "Y9000501", "FX-M7-1", "FX-M7-1", 1, "RL", 2507.528803609831, 2885.533721070001, 3606.9171513375013, "8-10 weeks", "GST EXTRA AS APPLICABLE"], ["Printer", "FX-OLD-7", "Y8000001", "FX-OLD-7", "FX-OLD-7", 1, "RL", 1000, 1150, 1437.5, "8-10 weeks", "GST EXTRA AS APPLICABLE"]]],
  ["J7300", [], ["Y Code", "Description", "Catalog", "UoM", "DP ( INR / UoM)", "EP ( INR/UoM)", "Lead Time", "Remarks"],
    [["Y9000601", "FX-J-1 (1.50 IN X 0.75 IN)", "FX-J-1", "ROL", 60260.8957648425, 75326.11970605313, "8-10 weeks", "GST EXTRA AS APPLICABLE"]]],
  ["HX SERIES SLEEVES", [], ["Material", "Material Description", "UoM", "DP ( INR/UoM", "EP ( INR/UoM)", "Lead Time", "Remarks"],
    [["Y9000701", "FX-HX-094-2", "ROL", 34002, 39102, "8-10 weeks", "GST EXTRA AS APPLICABLE"], ["Y9000702", "FX-HX-125-2", "ROL", 34413, 39575, "8-10 weeks", "GST EXTRA AS APPLICABLE"], ["Y9000703", "FX-HX-187-2", "ROL", 34106, 39222, "8-10 weeks", "GST EXTRA AS APPLICABLE"]]],
  ["BBP30_31_33_35_37", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Lead Time", "Remarks"],
    [["Consumables", 9142034, "Y9000801", 9142034, "FX B30 2.25IN", "ctr", 8764.351158517498, 10955.438948146873, "8-10 weeks", "GST EXTRA AS APPLICABLE"]]],
  ["PMK&BBP85_30.03.2026", [[null, null, null, null, null, "Recommended"]], ["Segment", "Y CODE", "Description", "Catalog", "UoM", "DP ( INR/UOM)", "EP ( INR/UOM)", "Remarks", "Lead Time"],
    [["BBP85", "Y9000901", "FX LAMINATING", 9105038, "EA", 103740.32284775248, 129675.4035596906, "GST Extra as applicable", "8-10 Weeks"]]],
  ["HMK and MNK", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Remarks", "Lead Time"],
    [["HMK", 9113182, "Y9001001", 9113182, "FX TAPE", "White", "100 FT", "CQ", 11554.514190082498, 14443.142737603122, "GST Extra as applicable", "8-10 Weeks"]]],
  ["Floor and other Tapes", [], ["Y CODE", "Material Description", "DP(INR/Uom)", "EP ( INR/UoM)", "UoM", "Catalog No", "Lead time", "remarks"],
    [["Y9001101", "FX FLOOR TAPE", 8326.317648285003, 10407.897060356254, "ROL", 9104340, "Lead Time 8-10 Weeks", "GST Extra As Applicable"]]],
  ["Codesoft", [], ["Label Design & Printing Software", "Perpetual (SWK & HWK)\r\n Non-VM licenses", null, null, null, null, "Subscription (SWK)", null],
    [[], [null, "SWK", "USB HWK", "SMA -1 yr", null, null, "First Year", "Renewal"], ["FX SOFT Pro", 80850, 96600, 20250, null, null, 52000, 50700]]],
  ["Pipe Marker", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Lead time", "remarks"],
    [[null, 9060314, "Y9001201", 9060314, "FX LABELS", "Black/Red on White", 1, "PK", 9187.66085328, 11484.5760666, "Lead Time 8-10 Weeks", "GST Extra As Applicable"]]],
  ["People ID and Tags", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Lead time", "Remarks", null],
    [["People ID", 9104111, "Y9001301", 9104111, "FX HOLDER", "NA", 1, "BX", 10361.08492965, 12951.3561620625, "Lead Time 8-10 Weeks", "GST Extra As Applicable"]]],
  ["LOTO Core", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "PACKAGE QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`],
    [["Padlocks", 9051339, "Y9001401", 9051339, "FX PADLOCK", "Red", 1, 6, "Pack", 5482.64700594, 6853.308757425], ["Padlocks", 9051340, "Y9001402", 9051340, "FX PADLOCK 2", "Red", 1, 6, "Pack", "Ask for Price", "Ask for Price"]]],
  ["Loto Non Core", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "PACKAGE QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`],
    [["Compact", 9143150, "Not got ", 9143150, "FX COMPACT", "Red", 1, 1, "Pack", 801.1491813, 1001.4364766250001]]],
  ["Sorbent", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "PACKAGE QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Lead Tine", "Remarks"],
    [["Sorbent", 9107693, "Y9001501", 9107693, "FX PAD", "NA", 1, 1, "PAL", 171338.206, 197038.9369, "12-14 Weeks", "GST Extra As Applicable"]]],
  ["LOTO", [], ["HEADER CODE", "CATALOG NUMBER", "Y NUMBER", "PRODUCT NUMBER", "DESCRIPTION", "Color", "SALES QTY", "PACKAGE QTY", "UOM", `Distributor Price ${T}`, `End User Price ${T}`, "Lead Tine", "Remarks"],
    [["LOTO", "NA", "Y9001601", 0, "FX PCB", "NA", 1, 1, "EA", 487.135023375, 608.91877921875, "12-14 Weeks", "GST Extra As Applicable"], ["LOTO", 9065318, "Y9001602", 9065318, "FX SEAL", "Black", 1, 1, "EA", 10.86880480725, 13.5860060090625, "12-14 Weeks", "GST Extra As Applicable"]]],
  ["M610", [], ["Catalog No", "Y Code", "Material Description", null, null, `Master Distributor Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Remarks ", "Lead Time "],
    [["FX-BMP-1", "Y9001701", "FX-BMP-1", null, null, 11470.713594334995, 13199.900568854999, 16499.875711068747, "GST EXTRA AS APPLICABLE", "8-10 Weeks"],
      ["Catalog No", "Y Code", "Material Description", "COLOR", "RIBBON SIZE", `Master Distributor Price ${T}`, `Distributor Price ${T}`, `End User Price ${T}`, "Remarks ", "Lead Time "],
      ["FX-BMP-2", "Y9001702", "FX-BMP-2", "BLACK", "2IN", 1682.541927111045, 1936.1817343049997, 2420.2271678812494, "GST EXTRA AS APPLICABLE", "8-10 Weeks"]]],
];

// Sheet -> array of rows, like the browser sends it.
const sheetRows = ([, spacers, header, rows]) => [...spacers, header, ...rows];

// A real .xlsx built from the styles (or a subset).
const workbookBuffer = (styles = STYLES) => {
  const wb = XLSX.utils.book_new();
  for (const s of styles) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows(s)), s[0]);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

// Workbook buffer -> [{ name, rows }] (trailing empty cells / rows dropped) —
// the same steps as the frontend's readPriceListWorkbook.
const rowsOf = (buffer) => {
  const wb = XLSX.read(buffer, { type: "buffer" });
  return wb.SheetNames.map((name) => {
    let rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: true });
    rows = rows.map((row) => {
      const a = [...row];
      while (a.length && (a[a.length - 1] === null || a[a.length - 1] === "")) a.pop();
      return a;
    });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return { name, rows };
  });
};

// Jest 30 also collects .cjs files under __tests__ (see poStack.cjs): when run
// as its own suite this file only checks that the fixtures are self-made.
const runAsSuite = (() => {
  try {
    const tp = typeof expect !== "undefined" && expect.getState().testPath;
    return !!tp && require("path").resolve(tp).toLowerCase() === __filename.toLowerCase();
  } catch {
    return false;
  }
})();
if (runAsSuite) {
  test("price-list fixtures: one sheet per header style, fake FX-/Y9… codes only", () => {
    expect(STYLES.length).toBe(21);
    const codes = STYLES.flatMap((s) => s[3]).flat().filter((v) => typeof v === "string" && /^(FX|Y[89]\d{6})/.test(v));
    expect(codes.length).toBeGreaterThan(20);
  });
}

module.exports = { STYLES, sheetRows, workbookBuffer, rowsOf };
