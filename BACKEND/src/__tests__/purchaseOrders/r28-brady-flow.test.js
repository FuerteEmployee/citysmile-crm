// Round 28 (Brady flow) — API tests: POSITIVE / NEGATIVE / INTEGRATION for
//   R3 price-list import (scan / preview / import in batches, remembered
//      mappings, duplicates, replacement links, PO Items columns + filters)
//   R2 PO number DA/07/26-27 (FY, 99 -> 100), company details (Q4)
//   R4 approval always, print data + WhatsApp only after Yes
//   R5 proforma invoice (create / edit / maths / words / WhatsApp / links)
//   R6 customer, price level (Q2), floor, margin never sent out
// Same safety stack as the other PO suites (poStack.cjs): in-memory MongoDB,
// WhatsApp + Cloudinary mocked, network guard, uploads canary.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const FX = require("./priceListFixtures.cjs");

jest.setTimeout(300000);
const P = S.PO_PATH;
const PL_PATH = `${P}/items/pricelist`;
let A, B, C, D;
const PoItem = () => require("../../models/PoItem");
const PoSettings = () => require("../../models/PoSettings");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const Proforma = () => require("../../models/ProformaInvoice");
const ActivityLog = () => require("../../models/ActivityLog");
const PDF = Buffer.from("%PDF-1.4 r28");
const BRADY = "9888877777";
const fy = S.fyNow();
// The client's price list (F2) — a read-only COPY in the session scratchpad.
// Never committed; the real-file tests are skipped when it isn't there.
const F2 = process.env.PO_F2_PATH || "E:/Temp/claude/e--CRM-NEW-CRM-NEW/b4c0c0d7-4097-409b-969e-0605f9c72294/scratchpad/xl/price/PRICE LIST SFI AND HPI FY 27 (2).xlsx";
const hasF2 = fs.existsSync(F2);
const realTest = hasF2 ? test : test.skip;

// Uploads canary (nothing may be written to the local uploads folders).
const UPLOAD_DIRS = [path.join(__dirname, "../../uploads"), path.join(__dirname, "../../../uploads")];
const snapshotUploads = () => {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    if (!fs.existsSync(d)) return h.update(`missing:${d}`);
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}:${fs.statSync(p).size}`);
    }
  };
  UPLOAD_DIRS.forEach(walk);
  return h.digest("hex");
};
let canary;
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

// The browser's import: scan -> (mapping) -> preview -> import in batches of 1000.
async function uploadPriceList(u, sheets, { priority, choices, batch = 1000 } = {}) {
  const t0 = Date.now();
  const scan = await u.api.post(`${PL_PATH}/scan`, { sheets });
  if (scan.status !== 200) return { scan };
  const withFields = sheets.map((s) => {
    const d = scan.body.sheets.find((x) => x.name === s.name);
    return { ...s, include: !d.skip_reason, fields: d.columns.map((c) => c.field), header_row: d.header_row };
  });
  const preview = await u.api.post(`${PL_PATH}/preview`, { sheets: withFields, priority, choices });
  if (preview.status !== 200) return { scan, preview };
  const records = preview.body.records;
  const mappings = scan.body.sheets.filter((d) => !d.skip_reason).map((d) => ({ signature: d.signature, sheet_name: d.name, fields: d.columns.map((c) => c.field) }));
  const results = [];
  for (let i = 0; i < Math.max(records.length, 1); i += batch) {
    const last = i + batch >= records.length;
    results.push(await u.api.post(`${PL_PATH}/import`, { records: records.slice(i, i + batch), ...(last ? { links: preview.body.links, mappings } : {}) }));
  }
  return { scan, preview, results, ms: Date.now() - t0 };
}

// Company profile (Setup > Settings) of a test company — a FAKE company.
async function seedCompanyProfile(T, extra = {}) {
  const db = mongoose.connection.db;
  const rows = { companyName: "Test Traders Pvt Ltd", compAddress: "12 Test Road", compCity: "Surat", compState: "Gujarat", compZip: "395001", compPhone: "9000012345", compEmail: "accounts@testtraders.test", compVat: "24TESTT1234T1Z5", ...extra };
  await db.collection("settings").insertMany(Object.entries(rows).map(([name, value]) => ({ name, value, tenant_id: T.tenantId })));
}

beforeAll(async () => {
  canary = snapshotUploads();
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] }); // add-on off
  D = await S.seedTenant("D"); // add-on ticked but not in the env list
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
  await seedCompanyProfile(A);
  await A.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady Test Supplier", address: "Test Park, Bengaluru", whatsapp: BRADY, state: "Karnataka" } });
});

afterAll(async () => {
  console.log("[guard] R28", JSON.stringify(S.guardReport()), "mocked wa", S.rec.whatsapp.length, "mocked uploads", S.rec.cloudinary.length, "real F2 copy:", hasF2 ? "used" : "absent (skipped)");
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(snapshotUploads()).toBe(canary);
  // margin is never part of anything sent out (WhatsApp captions / template values)
  expect(JSON.stringify(S.rec.whatsapp)).not.toMatch(/margin/i);
  await S.stopStack();
});

describe("R3 POSITIVE — fixture workbook (every header style)", () => {
  let up;
  test("scan: sheet list with item counts + skip reasons; preview counts; import in batches; summary", async () => {
    const sheets = FX.rowsOf(FX.workbookBuffer());
    up = await uploadPriceList(A.users.pricer, sheets, { batch: 7 });
    expect(up.scan.status).toBe(200);
    expect(up.scan.body.all_remembered).toBe(false);
    const code = up.scan.body.sheets.find((s) => s.name === "Codesoft");
    expect(code).toMatchObject({ skip_reason: "No catalog, Y code or price columns found — not an item list", item_rows: 0 });
    expect(up.scan.body.sheets.filter((s) => !s.skip_reason)).toHaveLength(20);
    expect(up.scan.body.priority[0]).toBe("New Replacement Part M611 M710");
    expect(up.scan.body.fields.map((f) => f.value)).toEqual(expect.arrayContaining(["catalog", "y_code", "master_price", "distributor_price", "end_customer_price", "attribute", "ignore"]));
    expect(up.preview.status).toBe(200);
    const sum = up.preview.body.summary;
    expect(sum).toMatchObject({ update: 0, unchanged: 0, skipped_sheets: 1, errors: 2, duplicates: 1 }); // FX-M7-1 on two sheets; + 1 Y-code-only row (round 31: catalog no. required)
    expect(sum.new).toBe(up.preview.body.records.length);
    expect(up.preview.body.errors).toEqual([expect.objectContaining({ sheet: "LOTO Core", catalog: "9051340", error: expect.stringMatching(/Distributor Price is not a number/) }), expect.objectContaining({ sheet: "LOTO", catalog: "Y9001601", error: "No catalog no. (Y code only) — not imported" })]);
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    expect(up.results.length).toBeGreaterThan(2); // batches of 7
    const created = up.results.reduce((s, r) => s + r.body.created, 0);
    expect(created).toBe(sum.new);
    expect(up.results.slice(-1)[0].body).toMatchObject({ linked: 1, remembered: 20 }); // 17 distinct layouts (some sheets share one)
  });
  test("PO Items: catalog, Y code, prices (2 dp), lead time, category (sheet), attributes, GST 18 (Q6)", async () => {
    const it = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-1`)).body.data[0];
    expect(it).toMatchObject({ item_code: "FX-M7-1", name: "FX-M7-1", y_code: "Y9000501", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, lead_time: "8-10 weeks", category: "BMP71 M710", tax_rate: 18, replaces: ["FX-OLD-7", "Y8000001"] });
    // Round 29 (S1): the price still comes from the priority sheet (New Replacement Part…), but the
    // series (category) is the item's own sheet "BMP71  M710" (spaces collapsed) — was the winning sheet.
    expect(it.attributes).toMatchObject({ "Replacement Part Available": "Yes", "Go Live for New Part/Obsolete Date for Existing": "2023-04-06" });
    const m210 = (await A.users.viewer.api.get(`${P}/items?search=FX-M21-100`)).body.data[0];
    expect(m210).toMatchObject({ master_price: 1000.12, distributor_price: 1150.99, end_customer_price: 1438.73, category: "M210", description: "CART FX 1IN" });
    expect(m210.attributes).toMatchObject({ Material: "Polyolefin", Color: "BLACK ON WHITE" });
    // HX: no MDP on the sheet
    const hx = (await A.users.viewer.api.get(`${P}/items?search=FX-HX-094-2`)).body.data[0];
    expect(hx).toMatchObject({ y_code: "Y9000701", master_price: 0, distributor_price: 34002 });
  });
  test("search by catalog / Y code / description / obsolete catalog; category (sheet) filter + list of categories", async () => {
    const v = A.users.viewer.api;
    expect((await v.get(`${P}/items?search=Y9000301`)).body.data.map((i) => i.item_code)).toEqual(["FX-M5-1"]);
    expect((await v.get(`${P}/items?search=fx floor tape`)).body.data.map((i) => i.item_code)).toEqual(["9104340"]);
    expect((await v.get(`${P}/items?search=FX-OLD-7`)).body.data.map((i) => i.item_code).sort()).toEqual(["FX-M7-1", "FX-OLD-7"]);
    const cats = (await v.get(`${P}/items/categories`)).body;
    expect(cats).toContain("HX SERIES SLEEVES");
    expect(cats).not.toContain("Codesoft");
    const hx = (await v.get(`${P}/items?category=${encodeURIComponent("HX SERIES SLEEVES")}&limit=500`)).body;
    expect(hx.total).toBe(3);
    expect((await v.get(`${P}/items?category[$ne]=x`)).status).toBe(400);
  });
  test("obsolete catalog -> its item points at the replacement; picking it on a PO warns", async () => {
    const old = (await A.users.viewer.api.get(`${P}/items?search=FX-OLD-7`)).body.data.find((i) => i.item_code === "FX-OLD-7");
    expect(old.replaced_by).toBe("FX-M7-1");
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(old, 1)] });
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual(["Line 1: FX-OLD-7 is obsolete — replaced by FX-M7-1"]);
  });
  test("saved mapping: the second upload of the same workbook is recognised (all sheets remembered) and changes nothing", async () => {
    const again = await uploadPriceList(A.users.pricer, FX.rowsOf(FX.workbookBuffer()));
    expect(again.scan.body.all_remembered).toBe(true);
    expect(again.scan.body.sheets.filter((s) => !s.skip_reason).every((s) => s.remembered)).toBe(true);
    expect(again.preview.body.summary).toMatchObject({ new: 0, update: 0 });
    expect(again.preview.body.records).toEqual([]);
    const settings = (await A.users.admin.api.get(`${P}/settings`)).body;
    expect(settings.import_mappings).toHaveLength(new Set(again.scan.body.sheets.filter((s) => !s.skip_reason).map((s) => s.signature)).size);
    expect(settings.import_mappings).toHaveLength(17); // sheets with the same header layout share one mapping
    expect(settings.import_mappings[0]).toEqual({ signature: expect.any(String), sheet_name: expect.any(String), saved_at: expect.any(String) });
  });
  test("a changed mapping is remembered: next scan shows the user's field", async () => {
    const sheets = FX.rowsOf(FX.workbookBuffer(FX.STYLES.filter((s) => s[0] === "M410")));
    const scan = (await A.users.pricer.api.post(`${PL_PATH}/scan`, { sheets })).body.sheets[0];
    const fields = scan.columns.map((c) => (c.header === "Description" ? "attribute" : c.field));
    const im = await A.users.pricer.api.post(`${PL_PATH}/import`, { records: [], mappings: [{ signature: scan.signature, sheet_name: "M410", fields }] });
    expect(im.status).toBe(200);
    const next = (await A.users.pricer.api.post(`${PL_PATH}/scan`, { sheets })).body.sheets[0];
    expect(next.columns.find((c) => c.header === "Description")).toMatchObject({ field: "attribute", auto_field: "description" });
  });
  test("duplicates: the user picks the other sheet for one catalog -> that price is imported", async () => {
    const sheets = FX.rowsOf(FX.workbookBuffer(FX.STYLES.filter((s) => ["New Replacement Part M611 M710", "BMP71  M710"].includes(s[0]))));
    const T = await S.seedTenant("DUP");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const up2 = await uploadPriceList(T.users.pricer, sheets, { choices: { "fx-m7-1": "BMP71  M710" } });
    expect(up2.preview.body.duplicates).toEqual([expect.objectContaining({ catalog: "FX-M7-1", chosen: "BMP71  M710" })]);
    const it = (await T.users.viewer.api.get(`${P}/items?search=FX-M7-1`)).body.data[0];
    // Round 29 (S1): the category is the sheet's SERIES name — the sheet name
    // with its double space collapsed ("BMP71  M710" -> "BMP71 M710").
    expect(it).toMatchObject({ master_price: 2507.53, category: "BMP71 M710", replaces: ["FX-OLD-7", "Y8000001"] });
  });
});

describe("R3 NEGATIVE", () => {
  const scan = (u, sheets) => u.api.post(`${PL_PATH}/scan`, { sheets });
  test("empty workbook / no sheets / not a list -> 400", async () => {
    expect((await scan(A.users.pricer, [])).body).toEqual({ message: "The workbook has no sheets" });
    expect((await scan(A.users.pricer, "abc")).status).toBe(400);
    expect((await A.users.pricer.api.post(`${PL_PATH}/preview`, {})).status).toBe(400);
  });
  test("a workbook with no recognisable columns -> every sheet skipped with a reason; preview imports nothing", async () => {
    const sheets = [{ name: "Notes", rows: [["Hello"], ["World"]] }, { name: "Grid", rows: [[1, 2], [3, 4]] }];
    const s = (await scan(A.users.pricer, sheets)).body;
    expect(s.sheets.map((x) => x.skip_reason)).toEqual(["No catalog, Y code or price columns found — not an item list", "No catalog, Y code or price columns found — not an item list"]);
    const pv = (await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets })).body;
    expect(pv.summary).toMatchObject({ new: 0, update: 0, skipped_sheets: 2 });
  });
  test("a price column of text + duplicate rows inside one sheet -> error rows, the good rows still import", async () => {
    const sheets = [{ name: "Bad", rows: [["Catalog No", "MDP", "DP", "EP"], ["NEG-1", "abc", 10, 12], ["NEG-2", 5, 6, 7], ["neg-2", 8, 9, 10], ["NEG-3", 1, 1, 1]] }];
    const pv = (await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets })).body;
    expect(pv.errors.map((e) => [e.row, e.error])).toEqual([[2, 'Master Distributor Price is not a number ("abc")'], [4, "Same catalog as row 3 of this sheet"]]);
    expect(pv.records.map((r) => r.item_code)).toEqual(["NEG-2", "NEG-3"]);
  });
  test("bad mapping values / header row outside the sheet -> 400", async () => {
    const rows = [["Catalog No", "MDP"], ["X-1", 1]];
    expect((await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets: [{ name: "S", rows, fields: ["catalog", "evil"] }] })).body.message).toBe('Unknown field "evil"');
    expect((await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets: [{ name: "S", rows, header_row: 9 }] })).status).toBe(400);
  });
  test("import: more than 1000 records / not a list / nothing -> 400; a bad record is reported, not saved", async () => {
    expect((await A.users.pricer.api.post(`${PL_PATH}/import`, { records: Array(1001).fill({ item_code: "X" }) })).status).toBe(400);
    expect((await A.users.pricer.api.post(`${PL_PATH}/import`, { records: "x" })).status).toBe(400);
    expect((await A.users.pricer.api.post(`${PL_PATH}/import`, { records: [] })).status).toBe(400);
    const r = await A.users.pricer.api.post(`${PL_PATH}/import`, { records: [{ item_code: "OK-1", master_price: 5 }, { y_code: "bad", master_price: 1 }, { master_price: 1 }, { item_code: "P-1", master_price: "abc" }] });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    // Round 29 (S4): the Y code rule is "Y" + 5 to 9 digits (new message).
    expect(r.body.errors.map((e) => e.error)).toEqual(["Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)", "No catalog or Y code", "master price is not a valid amount"]);
  });
  test("a body over 10 MB (like a 20 MB workbook) -> 413, nothing saved", async () => {
    const big = [1, 2].map((k) => ({ name: `Big${k}`, rows: Array.from({ length: 15000 }, (_, i) => [`B-${i}`, "x".repeat(500), 1, 2, 3]) }));
    const before = await PoItem().countDocuments({ tenant_id: A.tenantId });
    const r = await scan(A.users.pricer, big);
    expect(r.status).toBe(413);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("permissions: no Manage Prices -> 403 on scan / preview / import (maker, approver, viewer)", async () => {
    for (const u of ["maker", "approver", "viewer"]) {
      expect((await scan(A.users[u], [{ name: "S", rows: [] }])).status).toBe(403);
      expect((await A.users[u].api.post(`${PL_PATH}/preview`, { sheets: [{ name: "S", rows: [] }] })).status).toBe(403);
      expect((await A.users[u].api.post(`${PL_PATH}/import`, { records: [{ item_code: "Z" }] })).status).toBe(403);
    }
  });
});

describe("R2 / Q4 — PO number, company details", () => {
  test("PO number <prefix>/<nn>/<FY>; 99 -> 100; 31 Mar and 1 Apr are different series", async () => {
    const s = (await A.users.admin.api.get(`${P}/settings`)).body;
    const divs = s.divisions.map((d) => (d.key === "brady" ? { ...d, purchase_prefix: "DA" } : d));
    expect((await A.users.admin.api.put(`${P}/settings`, { divisions: divs })).status).toBe(200);
    const it = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-1`)).body.data[0];
    const make = (po_date) => A.users.maker.api.post(P, { type: "purchase", division: "brady", po_date, items: [S.line(it, 1)] });
    const mar = await make("2031-03-31");
    const apr = await make("2031-04-01");
    expect(mar.body.po_number).toBe("DA/01/30-31");
    expect(apr.body.po_number).toBe("DA/01/31-32");
    expect(mar.body.fy).toBe("30-31");
    await PoSettings().updateOne({ tenant_id: A.tenantId }, { $set: { "counters.brady_purchase_31-32": 98 } });
    expect((await make("2031-06-01")).body.po_number).toBe("DA/99/31-32");
    expect((await make("2031-06-02")).body.po_number).toBe("DA/100/31-32");
  });
  test("company details: prefilled from the CRM company profile until saved; then printed as saved", async () => {
    const s = (await A.users.viewer.api.get(`${P}/settings`)).body;
    expect(s.company).toMatchObject({ name: "Test Traders Pvt Ltd", address: "12 Test Road, Surat, Gujarat, 395001", gstin: "24TESTT1234T1Z5", state: "Gujarat", phone: "9000012345", prefilled: true });
    // only admins save; name required; text only
    expect((await A.users.maker.api.put(`${P}/settings`, { company: { name: "X" } })).status).toBe(403);
    expect((await A.users.admin.api.put(`${P}/settings`, { company: { name: "" } })).status).toBe(400);
    expect((await A.users.admin.api.put(`${P}/settings`, { company: { name: "T", gstin: { $gt: "" } } })).status).toBe(400);
    const saved = await A.users.admin.api.put(`${P}/settings`, { company: {
      ...s.company, line2: "Industrial Labels", bank_account_name: "Test Traders Pvt Ltd", bank_name_branch: "Test Bank, Ring Road", bank_account_no: "000111222333", bank_ifsc: "TEST0000123",
      po_terms: "Delivery to our Surat warehouse.", payment_terms: "ADVANCE", delivery_terms: "8-10 WEEKS",
    }, proforma: { prefix: "", valid_days: 10 } });
    expect(saved.status).toBe(200);
    expect(saved.body.company).toMatchObject({ name: "Test Traders Pvt Ltd", line2: "Industrial Labels", bank_ifsc: "TEST0000123", saved_at: expect.any(String) });
    expect(saved.body.company.prefilled).toBeUndefined();
    expect(saved.body.proforma).toEqual({ prefix: "", valid_days: 10 });
    expect((await A.users.admin.api.put(`${P}/settings`, { proforma: { valid_days: 999 } })).status).toBe(400);
    expect((await A.users.admin.api.put(`${P}/settings`, { proforma: { prefix: "has space" } })).status).toBe(400);
  });
});

describe("R6 / Q2 — customer price level, floor, margin", () => {
  test("price level distributor -> the floor is the Distributor Price; end user (default) -> End User Price", async () => {
    const it = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-1`)).body.data[0];
    const c2 = String(A.customers.c2._id);
    const below = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: c2, items: [S.line(it, 1, { selling_price: 4000 })] });
    expect(below.status).toBe(400);
    expect(below.body.message).toBe("Line 1 (FX-M7-1): price can't be lower than the price-master price 4613.6");
    expect((await A.users.maker.api.put(`${P}/settings/price-level`, { customer: c2, level: "distributor" })).status).toBe(403);
    expect((await A.users.pricer.api.put(`${P}/settings/price-level`, { customer: c2, level: "wholesale" })).status).toBe(400);
    expect((await A.users.pricer.api.put(`${P}/settings/price-level`, { customer: String(B.customers.c1._id), level: "distributor" })).status).toBe(400);
    const set = await A.users.pricer.api.put(`${P}/settings/price-level`, { customer: c2, level: "distributor" });
    expect(set.body).toEqual({ customer: c2, level: "distributor" });
    expect((await A.users.viewer.api.get(`${P}/settings`)).body.customer_price_levels).toEqual({ [c2]: "distributor" });
    const ok = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: c2, items: [S.line(it, 1)] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ price_level: "distributor" });
    expect(ok.body.items[0]).toMatchObject({ list_price: 3690.88, selling_price: 3690.88, cost_price: 3207.37, rate: 3207, margin_pct: 13.1, margin_amount: 483.51 });
    expect((await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: c2, items: [S.line(it, 1, { selling_price: 3690.87 })] })).status).toBe(400);
    await A.users.pricer.api.put(`${P}/settings/price-level`, { customer: c2, level: "end_user" });
    expect((await A.users.viewer.api.get(`${P}/settings`)).body.customer_price_levels).toEqual({});
  });
  test("Q1: an item with no MDP takes the DP as cost and the line says so", async () => {
    const hx = (await A.users.viewer.api.get(`${P}/items?search=FX-HX-094-2`)).body.data[0];
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(hx, 1)], submit: true });
    expect(r.body.items[0]).toMatchObject({ cost_price: 34002, cost_source: "dp", rate: 34002 });
    expect(r.body.approval.reasons).toEqual(["Line 1 (FX-HX-094-2): Cost from DP (no Master Distributor Price)"]);
  });
  test("margin is in the API for the editor only — the list export fields / WhatsApp never carry it (checked in afterAll)", async () => {
    const list = (await A.users.viewer.api.get(`${P}?limit=5`)).body.data;
    expect(list[0].totals).toHaveProperty("margin_amount");
  });
});

describe("R4 — approval always; PDF data + WhatsApp only after Yes", () => {
  let po;
  test("every line at the list price -> Submit -> pending (not approved); approvers notified", async () => {
    const it = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-2`)).body.data[0];
    const n = S.rec.io.length;
    po = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(it, 2)], submit: true })).body;
    expect(po.status).toBe("pending_approval");
    expect(po.approval).toMatchObject({ required: true, reasons: [] });
    expect(S.rec.io.slice(n).map((e) => e.room)).toContain(String(A.users.approver.id));
  });
  test("draft / pending: GET /:id/print -> 400 and WhatsApp -> 400, nothing sent", async () => {
    const n = S.rec.whatsapp.length;
    expect((await A.users.maker.api.get(`${P}/${po._id}/print`)).body).toEqual({ message: "The PO PDF is available only after an approver says Yes" });
    expect((await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF })).status).toBe(400);
    const draft = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).body;
    expect((await A.users.maker.api.get(`${P}/${draft._id}/print`)).status).toBe(400);
    expect(S.rec.whatsapp.length).toBe(n);
  });
  test("No (with reason) -> back to draft, nothing sent; resubmit -> Yes -> print data has the F1 inputs (company + supplier, cost rates)", async () => {
    const no = await A.users.approver.api.post(`${P}/${po._id}/reject`, { reason: "check qty" });
    expect(no.body.status).toBe("draft");
    expect((await A.users.maker.api.get(`${P}/${po._id}/print`)).status).toBe(400);
    await A.users.maker.api.post(`${P}/${po._id}/submit`, {});
    expect((await A.users.approver.api.post(`${P}/${po._id}/approve`, {})).body.status).toBe("approved");
    const pr = await A.users.maker.api.get(`${P}/${po._id}/print`);
    expect(pr.status).toBe(200);
    expect(pr.body.company).toMatchObject({ name: "Test Traders Pvt Ltd", gstin: "24TESTT1234T1Z5" });
    expect(pr.body.po.supplier).toMatchObject({ name: "Brady Test Supplier", whatsapp: BRADY });
    expect(pr.body.po.items[0]).toMatchObject({ item_code: "FX-M7-2", y_code: "Y9000502", rate: 1869, qty: 2, amount: 3738, tax_rate: 18 });
    expect(pr.body.po.po_number).toMatch(new RegExp(`^DA/\\d{2,}/${fy}$`));
  });
  test("other company's PO -> 404 on print; tenant not in the env list -> 403", async () => {
    expect((await B.users.admin.api.get(`${P}/${po._id}/print`)).status).toBe(404);
    expect((await D.users.admin.api.get(`${P}/${po._id}/print`)).status).toBe(403);
  });
});

describe("R5 — Proforma invoice", () => {
  let po;
  let pf;
  beforeAll(async () => {
    const it1 = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-1`)).body.data[0];
    const it2 = (await A.users.viewer.api.get(`${P}/items?search=FX-M7-2`)).body.data[0];
    po = await S.approvedPo(A, [S.line(it1, 1, { selling_price: 4700.4 }), S.line(it2, 2)], { customer: String(A.customers.c1._id), customer_po_number: "ACME-77", customer_po_date: "2026-10-20" });
  });
  test("draft / pending / cancelled PO -> 400; PO without a customer -> 400", async () => {
    const d = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] })).body;
    expect((await A.users.maker.api.post(`${P}/${d._id}/proforma`, {})).body).toEqual({ message: "A proforma can only be made after the PO is approved" });
    await A.users.maker.api.post(`${P}/${d._id}/submit`, {});
    expect((await A.users.maker.api.post(`${P}/${d._id}/proforma`, {})).status).toBe(400);
    await A.users.admin.api.post(`${P}/${d._id}/status`, { status: "cancelled" });
    expect((await A.users.maker.api.post(`${P}/${d._id}/proforma`, {})).status).toBe(400);
    // Round 29 (S4): new POs always have a customer — an OLD approved "stock"
    // PO (made before) is simulated by removing it in the in-memory DB.
    const stock = await S.approvedPo(A, [S.line(A.items.I1, 1)]);
    await PurchaseOrder().updateOne({ _id: stock._id }, { $unset: { customer: 1, customer_snapshot: 1 } });
    expect((await A.users.maker.api.post(`${P}/${stock._id}/proforma`, {})).body).toEqual({ message: "This PO has no customer — a proforma invoice needs one" });
  });
  test("create: bill to = the PO's customer, same lines at the selling price (whole rupees), CGST+SGST in the same state, number 0001, words", async () => {
    const r = await A.users.maker.api.post(`${P}/${po._id}/proforma`, {});
    expect(r.status).toBe(201);
    pf = r.body;
    expect(pf).toMatchObject({ number: "0001", fy, po_number: po.po_number, status: "draft", tax_type: "cgst_sgst", customer_po_number: "ACME-77" });
    expect(pf.bill_to).toMatchObject({ name: "Acme A", gstin: "24ABCDE1234F1Z5", state: "Gujarat" });
    expect(pf.seller).toMatchObject({ name: "Test Traders Pvt Ltd", bank_account_no: "000111222333", payment_terms: "ADVANCE" });
    expect(pf.lines.map((l) => [l.ref_no, l.description, l.qty, l.rate, l.gst_pct])).toEqual([["FX-M7-1", "Y9000501", 1, 4700, 18], ["FX-M7-2", "Y9000502", 2, 2689, 18]]);
    // 4700 + 2 x 423 = 5546; 5378 + 2 x 484.02 = 6346.04
    expect(pf.lines.map((l) => l.total)).toEqual([5546, 6346.04]);
    expect(pf.totals).toEqual({ taxable: 10078, cgst: 907.02, sgst: 907.02, igst: 0, grand_total: 11892.04, advance: 0, balance: 11892.04 });
    expect(pf.amount_in_words).toBe("Eleven thousand eight hundred ninety two rupees and four paisa only.");
    const days = (new Date(pf.valid_until) - new Date(pf.date)) / 86400000;
    expect(Math.round(days)).toBe(10);
  });
  test("linked both ways: the PO lists its proforma; PO history + Activity Log on both", async () => {
    const g = (await A.users.viewer.api.get(`${P}/${po._id}`)).body;
    expect(g.proformas).toEqual([expect.objectContaining({ _id: pf._id, number: "0001", status: "draft" })]);
    expect(g.history.slice(-1)[0]).toMatchObject({ action: "proforma_created", note: "0001" });
    const p = (await A.users.viewer.api.get(`${P}/proformas/${pf._id}`)).body;
    expect(p.po).toMatchObject({ _id: po._id, po_number: po.po_number, status: "approved" });
    const logs = await waitFor(async () => {
      const x = await ActivityLog().find({ tenant_id: A.tenantId, description: /0001/ }).lean();
      return x.length >= 2 ? x : null;
    });
    expect(logs.map((l) => l.rel_type).sort()).toEqual(["proforma_invoice", "purchase_order"]);
  });
  test("a second proforma for the same PO asks first (409 proforma_exists); { again: true } makes 0002", async () => {
    const x = await A.users.maker.api.post(`${P}/${po._id}/proforma`, {});
    expect(x.status).toBe(409);
    expect(x.body).toMatchObject({ code: "proforma_exists", existing: [{ number: "0001" }] });
    const y = await A.users.maker.api.post(`${P}/${po._id}/proforma`, { again: true });
    expect(y.status).toBe(201);
    expect(y.body.number).toBe("0002");
    expect((await A.users.maker.api.post(`${P}/proformas/${y.body._id}/cancel`, {})).body.status).toBe("cancelled");
  });
  test("edit: IGST switch, Disc %, freight line, advance -> balance; words follow the real total", async () => {
    const lines = [
      { _id: pf.lines[0]._id, disc_pct: 10 },
      { _id: pf.lines[1]._id, gst_pct: 18 },
      { is_extra: true, description: "Freight / packing", qty: 1, rate: 500, gst_pct: 18 },
    ];
    const r = await A.users.maker.api.put(`${P}/proformas/${pf._id}`, { tax_type: "igst", lines, advance: 5000 });
    expect(r.status).toBe(200);
    // 4700 x 0.9 = 4230 -> +761.40 ; 5378 -> +968.04 ; freight 500 -> +90
    expect(r.body.lines.map((l) => [l.taxable, l.total])).toEqual([[4230, 4991.4], [5378, 6346.04], [500, 590]]);
    expect(r.body.totals).toEqual({ taxable: 10108, cgst: 0, sgst: 0, igst: 1819.44, grand_total: 11927.44, advance: 5000, balance: 6927.44 });
    expect(r.body.amount_in_words).toBe("Eleven thousand nine hundred twenty seven rupees and forty four paisa only.");
    pf = r.body;
  });
  test("negative Disc % / Disc > 100 / advance > grand total / valid-until before the date / unknown line -> 400; unchanged", async () => {
    const put = (body) => A.users.maker.api.put(`${P}/proformas/${pf._id}`, body);
    expect((await put({ lines: [{ _id: pf.lines[0]._id, disc_pct: -5 }] })).body.message).toBe("Line 1: Disc % can't be negative");
    expect((await put({ lines: [{ _id: pf.lines[0]._id, disc_pct: 101 }] })).body.message).toBe("Line 1: Disc % can't be more than 100");
    expect((await put({ advance: 999999 })).body.message).toBe("Advance received can't be more than the grand total");
    expect((await put({ advance: -1 })).status).toBe(400);
    expect((await put({ valid_until: "2000-01-01" })).body.message).toBe("Valid until can't be before the proforma date");
    expect((await put({ tax_type: "vat" })).status).toBe(400);
    expect((await put({ lines: [{ _id: String(new mongoose.Types.ObjectId()), disc_pct: 1 }] })).body.message).toBe("Line 1: unknown line");
    expect((await put({ lines: [{ is_extra: true, description: "", rate: 1 }] })).status).toBe(400);
    expect((await put({ bill_to: { name: "" } })).status).toBe(400);
    expect((await Proforma().findById(pf._id).lean()).totals.grand_total).toBe(11927.44);
  });
  test("list: search by number / customer / PO no.; status filter; other company never listed", async () => {
    const v = A.users.viewer.api;
    expect((await v.get(`${P}/proformas?search=0001`)).body.data.map((p) => p.number)).toEqual(["0001"]);
    expect((await v.get(`${P}/proformas?search=acme a`)).body.total).toBe(2);
    expect((await v.get(`${P}/proformas?status=cancelled`)).body.data.map((p) => p.number)).toEqual(["0002"]);
    expect((await v.get(`${P}/proformas?status=xyz`)).status).toBe(400);
    expect((await B.users.admin.api.get(`${P}/proformas`)).body.total).toBe(0);
  });
  test("WhatsApp to the customer (mocked): document inside the window -> sent, locked; edits then 400", async () => {
    const { WhatsAppInbox } = { WhatsAppInbox: require("../../models/WhatsAppInbox") };
    await WhatsAppInbox.create({ tenant_id: A.tenantId, from: "919876543210", mobile: "9876543210", direction: "in", message: "hi", received_at: new Date() });
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: PDF, filename: "p.pdf" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("sent");
    const call = S.rec.whatsapp.slice(n).find((c) => c.fn === "sendDocumentMessage");
    expect(call).toMatchObject({ mobile: "9876543210", filename: "Proforma-0001.pdf", caption: "Proforma invoice 0001" });
    expect(r.body.whatsapp_log[0]).toMatchObject({ to: "9876543210", status: "sent" });
    expect((await A.users.maker.api.put(`${P}/proformas/${pf._id}`, { advance: 1 })).body.message).toBe("A sent proforma is locked");
  });
  test("WhatsApp: not a PDF / no file / cancelled -> 400; no Edit -> 403", async () => {
    expect((await A.users.maker.api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: Buffer.from("MZ..") })).status).toBe(400);
    expect((await A.users.maker.api.upload(`${P}/proformas/${pf._id}/whatsapp`, {})).body.message).toBe("The proforma PDF is missing");
    expect((await A.users.viewer.api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: PDF })).status).toBe(403);
    const cancelled = (await A.users.viewer.api.get(`${P}/proformas?status=cancelled`)).body.data[0];
    expect((await A.users.maker.api.upload(`${P}/proformas/${cancelled._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } })).body.message).toBe("This proforma is cancelled");
  });
  test("permissions + company separation: viewer/approver can't create (403); other company's ids -> 404; gate 403", async () => {
    expect((await A.users.viewer.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(403);
    expect((await A.users.approver.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(403);
    expect((await A.users.viewer.api.put(`${P}/proformas/${pf._id}`, { advance: 1 })).status).toBe(403);
    expect((await A.users.viewer.api.post(`${P}/proformas/${pf._id}/cancel`, {})).status).toBe(403);
    for (const path2 of [`/proformas/${pf._id}`, `/proformas/${pf._id}/print`]) expect((await B.users.admin.api.get(`${P}${path2}`)).status).toBe(404);
    expect((await B.users.admin.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(404);
    expect((await A.users.viewer.api.get(`${P}/proformas/not-an-id`)).status).toBe(404);
  });
  test("tenant not in PURCHASE_ORDERS_TENANT_IDS / add-on off -> 403 on EVERY new endpoint", async () => {
    for (const T of [C, D]) {
      const api = T.users.admin.api;
      const res = [
        (await api.post(`${PL_PATH}/scan`, { sheets: [] })).status,
        (await api.post(`${PL_PATH}/preview`, { sheets: [] })).status,
        (await api.post(`${PL_PATH}/import`, { records: [] })).status,
        (await api.get(`${P}/items/categories`)).status,
        (await api.put(`${P}/settings/price-level`, { customer: "x", level: "end_user" })).status,
        (await api.get(`${P}/${po._id}/print`)).status,
        (await api.post(`${P}/${po._id}/proforma`, {})).status,
        (await api.get(`${P}/proformas`)).status,
        (await api.get(`${P}/proformas/${pf._id}`)).status,
        (await api.get(`${P}/proformas/${pf._id}/print`)).status,
        (await api.put(`${P}/proformas/${pf._id}`, {})).status,
        (await api.post(`${P}/proformas/${pf._id}/cancel`, {})).status,
        (await api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: PDF })).status,
      ];
      expect(res).toEqual(Array(13).fill(403));
    }
    expect((await S.api(null).get(`${P}/proformas`)).status).toBe(401);
  });
});

describe("Q4 — no sample company from the client's files anywhere in the code", () => {
  test("the two sample company names of F1 / F3 do not appear in backend or frontend source", () => {
    const words = ["DIS" + "HAN", "GLOB" + "SPOT"];
    const roots = [path.join(__dirname, "../.."), path.join(__dirname, "../../../../FRONTEND/src")];
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", "uploads"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|cjs|ts|tsx|json)$/.test(e.name)) {
          const text = fs.readFileSync(p, "utf8").toUpperCase();
          words.forEach((w) => { if (text.includes(w)) hits.push(`${p}: ${w}`); });
        }
      }
    };
    roots.forEach((r) => fs.existsSync(r) && walk(r));
    expect(hits).toEqual([]);
  });
});

describe("2.2 / 2.4 — the real price list (copy of F2) + the full flow", () => {
  let item;
  realTest("import the real F2 copy: all item sheets -> preview -> import in batches < 30 s; M7-84-499 from the priority sheet", async () => {
    const XLSX = require("xlsx");
    const wb = XLSX.read(fs.readFileSync(F2), { type: "buffer" });
    const sheets = FX.rowsOf(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const T = await S.seedTenant("F2");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const up = await uploadPriceList(T.users.pricer, sheets);
    console.log("[record] F2 import ms", up.ms, "summary", JSON.stringify(up.preview.body.summary), "batches", up.results.length);
    expect(up.ms).toBeLessThan(30000);
    expect(up.scan.body.sheets.length).toBe(21);
    expect(up.scan.body.sheets.filter((s) => s.skip_reason).map((s) => s.name)).toEqual(["Codesoft"]);
    expect(up.preview.body.summary.new).toBeGreaterThan(6000);
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    const it = (await T.users.viewer.api.get(`${P}/items?search=M7-84-499`)).body.data.find((i) => i.item_code === "M7-84-499");
    expect(it).toMatchObject({ y_code: "Y5075406", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6 });
    // the same catalog on "BMP71 M710" lost to the priority sheet; both prices were listed
    expect(up.preview.body.duplicates.find((d) => d.catalog === "M7-84-499").options.map((o) => o.master_price)).toEqual([3207.37, 2507.53]);
    // second upload of the same file: mapping remembered (no mapping step), nothing new
    const again = await T.users.pricer.api.post(`${PL_PATH}/scan`, { sheets });
    expect(again.body.all_remembered).toBe(true);
    A.f2 = T;
    item = it;
  });

  realTest("full flow in ONE test: F2 -> PO (customer + raised price) -> approver notified -> Yes -> print (F1 data) -> WhatsApp Brady -> proforma (F3 data) -> WhatsApp customer; history + logs; re-upload with new prices leaves both unchanged", async () => {
    const T = A.f2;
    await seedCompanyProfile(T);
    await T.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady Test Supplier", whatsapp: BRADY } });
    const r7300 = (await T.users.viewer.api.get(`${P}/items?search=M7-R4300`)).body.data.find((i) => i.item_code === "M7-R4300");
    const n = S.rec.io.length;
    const created = await T.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(T.customers.c1._id), customer_po_number: "TEST-CUST-1", items: [S.line(item, 1, { selling_price: 4800 }), S.line(r7300, 1)], submit: true });
    expect(created.status).toBe(201);
    const po = created.body;
    expect(po).toMatchObject({ status: "pending_approval", po_number: `PPO/01/${fy}` });
    expect(po.items.map((l) => [l.item_code, l.y_code, l.rate, l.amount])).toEqual([["M7-84-499", "Y5075406", 3207, 3207], ["M7-R4300", "Y5074256", 1869, 1869]]);
    expect(po.totals).toMatchObject({ subtotal: 5076, tax_total: 913.68, grand_total: 5989.68 });
    expect(po.approval.reasons).toEqual(["Line 1 (M7-84-499): Price raised from 4613.6 to 4800"]);
    expect(S.rec.io.slice(n).some((e) => e.room === String(T.users.approver.id) && e.payload.event === "requested")).toBe(true);
    const yes = await T.users.approver.api.post(`${P}/${po._id}/approve`, {});
    expect(yes.body.status).toBe("approved");
    const pr = (await T.users.maker.api.get(`${P}/${po._id}/print`)).body;
    expect(pr.company.name).toBe("Test Traders Pvt Ltd");
    await require("../../models/WhatsAppInbox").create({ tenant_id: T.tenantId, from: `91${BRADY}`, mobile: BRADY, direction: "in", message: "hi", received_at: new Date() });
    const sent = await T.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF });
    expect(sent.body.status).toBe("sent");
    const pfr = await T.users.maker.api.post(`${P}/${po._id}/proforma`, {});
    expect(pfr.status).toBe(201);
    const pf = pfr.body;
    expect(pf.lines.map((l) => [l.ref_no, l.description, l.rate])).toEqual([["M7-84-499", "Y5075406", 4800], ["M7-R4300", "Y5074256", 2689]]);
    expect(pf.totals.grand_total).toBe(8837.02);
    expect(pf.amount_in_words).toBe("Eight thousand eight hundred thirty seven rupees and two paisa only.");
    await require("../../models/WhatsAppInbox").create({ tenant_id: T.tenantId, from: "919876543210", mobile: "9876543210", direction: "in", message: "hi", received_at: new Date() });
    const pfSent = await T.users.maker.api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: PDF });
    expect(pfSent.body.status).toBe("sent");
    const g = (await T.users.viewer.api.get(`${P}/${po._id}`)).body;
    expect(g.history.map((h) => h.action)).toEqual(["created", "submitted", "approved", "whatsapp", "status:sent", "proforma_created"]);
    expect(g.proformas.map((p) => p.number)).toEqual(["0001"]);
    const pfg = (await T.users.viewer.api.get(`${P}/proformas/${pf._id}`)).body;
    expect(pfg.history.map((h) => h.action)).toEqual(["created", "whatsapp"]);
    expect(pfg.po.po_number).toBe(po.po_number);
    // Re-upload with changed prices: new POs use them; the approved PO and the proforma don't change.
    const XLSX = require("xlsx");
    const wb = XLSX.read(fs.readFileSync(F2), { type: "buffer" });
    const sheets = FX.rowsOf(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const nrp = sheets.find((s) => s.name.startsWith("New Replacement"));
    const row = nrp.rows.find((r) => r[4] === "M7-84-499");
    row[6] = 3300; row[7] = 3800; row[8] = 4750;
    const up = await uploadPriceList(T.users.pricer, [nrp]);
    expect(up.preview.body.summary.update).toBeGreaterThanOrEqual(1);
    const fresh = await T.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(item, 1)] });
    expect(fresh.body.items[0]).toMatchObject({ cost_price: 3300, rate: 3300, list_price: 4750 });
    expect((await T.users.viewer.api.get(`${P}/${po._id}`)).body.items[0]).toMatchObject({ cost_price: 3207.37, list_price: 4613.6, selling_price: 4800 });
    expect((await T.users.viewer.api.get(`${P}/proformas/${pf._id}`)).body.totals.grand_total).toBe(8837.02);
  });
});
