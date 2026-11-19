// Round 30 — API tests: S6 "first sheet by default + Add Catalog No."
//   POSITIVE: upload with only the first sheet ticked → only its catalogs are
//     PO items, the WHOLE file is the reference; find / add by catalog, Y code,
//     obsolete catalog; paste 3; re-upload replaces the reference and leaves
//     PO items alone unless their sheet is ticked.
//   NEGATIVE: unknown, already in PO Items, empty, 201 pasted, no reference,
//     no permission, other company, tenant without the add-on, bad batches.
//   INTEGRATION (real F2 copy): upload with defaults → exactly 77 PO items +
//     6,152 in the reference → add M7-84-499 → use on a PO → submit → Yes;
//     and the round-5 fix "Approved POs are locked · has a proforma invoice".
// Same safety stack as the other PO suites (poStack.cjs): in-memory MongoDB,
// WhatsApp + Cloudinary mocked, network guard, uploads canary.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./poStack.cjs");
const PLFX = require("./priceListFixtures.cjs");

jest.setTimeout(300000);
const P = S.PO_PATH;
const PL_PATH = `${P}/items/pricelist`;
const FIND = `${P}/items/catalog/find`;
const ADD = `${P}/items/catalog/add`;
let A, B, C;
const PoItem = () => require("../../models/PoItem");
const Entry = () => require("../../models/PoPriceListEntry");
const fy = S.fyNow();
const F2 = process.env.PO_F2_PATH || "E:/Temp/claude/e--CRM-NEW-CRM-NEW/b4c0c0d7-4097-409b-969e-0605f9c72294/scratchpad/xl/price/PRICE LIST SFI AND HPI FY 27 (2).xlsx";
const hasF2 = fs.existsSync(F2);
const realTest = hasF2 ? test : test.skip;

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

// The browser's upload: scan → (default ticks = the FIRST item sheet, or
// `tick`) → preview → import batches → the reference in batches (done last).
async function upload(u, sheets, { tick = null, refBatch = 2000, fileName = "price.xlsx" } = {}) {
  const scan = await u.api.post(`${PL_PATH}/scan`, { sheets });
  if (scan.status !== 200) return { scan };
  const firstItemSheet = scan.body.sheets.find((s) => !s.skip_reason)?.name;
  const isTicked = (name) => (tick ? tick.includes(name) : name === firstItemSheet);
  const body = sheets.map((s) => {
    const d = scan.body.sheets.find((x) => x.name === s.name);
    return { ...s, include: !d.skip_reason && isTicked(s.name), fields: d.columns.map((c) => c.field), header_row: d.header_row, series: d.series };
  });
  const preview = await u.api.post(`${PL_PATH}/preview`, { sheets: body });
  if (preview.status !== 200) return { scan, preview };
  const mappings = scan.body.sheets.filter((d) => !d.skip_reason && isTicked(d.name)).map((d) => ({ signature: d.signature, sheet_name: d.name, fields: d.columns.map((c) => c.field) }));
  const results = [];
  const recs = preview.body.records;
  for (let i = 0; i < Math.max(recs.length, 1); i += 1000) {
    const last = i + 1000 >= recs.length;
    results.push(await u.api.post(`${PL_PATH}/import`, { records: recs.slice(i, i + 1000), ...(last ? { links: preview.body.links, mappings } : {}) }));
  }
  const uploadId = crypto.randomUUID();
  const ref = [];
  const all = preview.body.reference;
  for (let i = 0; i < all.length; i += refBatch) {
    ref.push(await u.api.post(`${PL_PATH}/reference`, { upload_id: uploadId, entries: all.slice(i, i + refBatch), done: i + refBatch >= all.length, file_name: fileName }));
  }
  return { scan, preview, results, ref, uploadId };
}

beforeAll(async () => {
  canary = snapshotUploads();
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] });
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] R30", JSON.stringify(S.guardReport()), "mocked wa", S.rec.whatsapp.length, "mocked uploads", S.rec.cloudinary.length, "real F2 copy:", hasF2 ? "used" : "absent (skipped)");
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(snapshotUploads()).toBe(canary);
  await S.stopStack();
});

const sheets = () => PLFX.rowsOf(PLFX.workbookBuffer());
const codesOf = async (T) => (await PoItem().find({ tenant_id: T.tenantId, category: { $ne: "" } }).lean()).map((i) => i.item_code).sort();

describe("S6 POSITIVE — fixture workbook", () => {
  let up;
  test("default upload: only the FIRST item sheet (M210) becomes PO items; every readable sheet goes to the reference", async () => {
    up = await upload(A.users.pricer, sheets());
    expect(up.scan.status).toBe(200);
    expect(up.preview.status).toBe(200);
    const pv = up.preview.body;
    expect(pv.sheets.filter((s) => s.included).map((s) => s.name)).toEqual(["M210"]);
    expect(pv.records.map((r) => r.item_code).sort()).toEqual(["FX-M21-100", "FX-M21-200"]);
    expect(pv.summary).toMatchObject({ new: 2, update: 0, total: 2, reference_sheets: 20 });
    expect(pv.summary.reference).toBe(pv.reference.length);
    expect(pv.reference.length).toBeGreaterThan(20);
    // the not-ticked sheets are "Not selected" but still give reference rows
    expect(pv.sheets.find((s) => s.name === "BMP71  M710")).toMatchObject({ included: false, skip_reason: "Not selected", item_rows: 0, reference_rows: 2, series: "BMP71 M710" });
    expect(pv.sheets.find((s) => s.name === "Codesoft")).toMatchObject({ reference_rows: 0 });
    // errors / duplicates are listed only for the ticked sheets
    expect(pv.errors).toEqual([]);
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    expect(up.ref.map((r) => r.status)).toEqual([200]);
    expect(up.ref[0].body).toMatchObject({ done: true, count: pv.reference.length, removed: 0 });
    expect(await codesOf(A)).toEqual(["FX-M21-100", "FX-M21-200"]);
    expect(await Entry().countDocuments({ tenant_id: A.tenantId })).toBe(pv.reference.length);
    const st = (await A.users.viewer.api.get(`${PL_PATH}/reference`)).body;
    expect(st).toMatchObject({ count: pv.reference.length, file_name: "price.xlsx" });
    expect((await A.users.viewer.api.get(`${P}/items/series`)).body.reference).toMatchObject({ count: pv.reference.length, file_name: "price.xlsx" });
  });

  test("Find FX-M7-1: series = its own sheet (BMP71 M710), prices from the priority sheet; Add → a PO item with those values", async () => {
    const f = await A.users.maker.api.post(FIND, { text: "fx-m7-1" });
    expect(f.status).toBe(200);
    expect(f.body.can_add).toBe(false); // maker has no Manage Prices
    expect(f.body.results).toEqual([expect.objectContaining({
      query: "fx-m7-1", status: "found", via: "catalog",
      entry: expect.objectContaining({ item_code: "FX-M7-1", y_code: "Y9000501", category: "BMP71 M710", price_sheet: "New Replacement Part M611 M710", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, lead_time: "8-10 weeks" }),
    })]);
    expect((await A.users.pricer.api.post(FIND, { text: "FX-M7-1" })).body.can_add).toBe(true);
    const a = await A.users.pricer.api.post(ADD, { text: "FX-M7-1" });
    expect(a.status).toBe(201);
    expect(a.body.summary).toEqual({ added: 1, found: 0, already: 0, not_found: 0 });
    expect(a.body.results[0]).toMatchObject({ status: "added", message: "Added to PO Items", item: { item_code: "FX-M7-1", category: "BMP71 M710", active: true } });
    const it = await PoItem().findOne({ tenant_id: A.tenantId, item_code: "FX-M7-1" }).lean();
    expect(it).toMatchObject({ name: "FX-M7-1", y_code: "Y9000501", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, category: "BMP71 M710", price_sheet: "New Replacement Part M611 M710", tax_rate: 18, unit: "Nos", replaces: ["FX-OLD-7", "Y8000001"] });
    // listed in its series with a count
    const ser = (await A.users.viewer.api.get(`${P}/items/series`)).body.series;
    expect(ser.find((s) => s.name === "BMP71 M710").count).toBe(1);
  });

  test("Find again → 'Already in PO Items' with the item; Add again → nothing added (200)", async () => {
    const f = (await A.users.viewer.api.post(FIND, { text: "FX-M7-1" })).body;
    expect(f.results[0]).toMatchObject({ status: "already", message: "Already in PO Items", item: { item_code: "FX-M7-1" } });
    const again = await A.users.pricer.api.post(ADD, { text: "FX-M7-1" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ added: 0, summary: { added: 0, already: 1 } });
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, item_code: "FX-M7-1" })).toBe(1);
  });

  test("paste 3 (catalog, Y code, unknown) + an obsolete Y code + a duplicate line → table; Add all found", async () => {
    const text = "FX-M4-1\nY9000301, NOPE-1\n\nfx-m4-1\nY8000001";
    const f = (await A.users.pricer.api.post(FIND, { text })).body;
    expect(f.results.map((r) => [r.query, r.status, r.via, r.entry?.item_code || null])).toEqual([
      ["FX-M4-1", "found", "catalog", "FX-M4-1"],
      ["Y9000301", "found", "y_code", "FX-M5-1"],
      ["NOPE-1", "not_found", null, null],
      ["Y8000001", "already", "y_code", "FX-OLD-7"], // FX-OLD-7's Y — but FX-M7-1 (a PO item) replaces Y8000001
    ]);
    expect(f.results[2].message).toBe("Not in the uploaded price list — add it by hand");
    expect(f.summary).toEqual({ found: 2, already: 1, not_found: 1 });
    const a = (await A.users.pricer.api.post(ADD, { text })).body;
    expect(a.summary).toEqual({ added: 2, found: 0, already: 1, not_found: 1 });
    expect(await codesOf(A)).toEqual(["FX-M21-100", "FX-M21-200", "FX-M4-1", "FX-M5-1", "FX-M7-1"]);
    expect((await PoItem().findOne({ tenant_id: A.tenantId, item_code: "FX-M5-1" }).lean()).category).toBe("M511");
  });

  test("a catalog and its own Y code pasted together → added once", async () => {
    const a = (await A.users.pricer.api.post(ADD, { text: "FX-M6-1\nY9000401" })).body;
    expect(a.results.map((r) => r.status)).toEqual(["added", "already"]);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, item_code: "FX-M6-1" })).toBe(1);
  });

  test("two Adds of the same catalog at once → one PO item (lock)", async () => {
    const [x, y] = await Promise.all([A.users.pricer.api.post(ADD, { text: "FX-M4C-1" }), A.users.pricer.api.post(ADD, { text: "FX-M4C-1" })]);
    expect([x.body.added, y.body.added].sort()).toEqual([0, 1]);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, item_code: "FX-M4C-1" })).toBe(1);
  });

  test("the picker search: a PO item search misses, find hits the reference (maker: can_add false)", async () => {
    expect((await A.users.maker.api.get(`${P}/items?active=true&search=FX-M5-2`)).body.total).toBe(0);
    const f = (await A.users.maker.api.post(FIND, { text: "FX-M5-2" })).body;
    expect(f).toMatchObject({ can_add: false, results: [expect.objectContaining({ status: "found", entry: expect.objectContaining({ item_code: "FX-M5-2", category: "M511" }) })] });
    expect((await A.users.maker.api.post(ADD, { text: "FX-M5-2" })).status).toBe(403);
  });

  test("re-upload with a new FX-M7-1 price, M210 ticked: reference replaced (old entries gone), the PO item keeps its price", async () => {
    const changed = sheets();
    const nrp = changed.find((s) => s.name.startsWith("New Replacement"));
    const row = nrp.rows.find((r) => r[4] === "FX-M7-1");
    row[6] = 3300; row[7] = 3800; row[8] = 4750;
    const before = up.uploadId;
    const again = await upload(A.users.pricer, changed, { refBatch: 7 });
    expect(again.ref.length).toBeGreaterThan(1); // several batches
    expect(again.ref.every((r) => r.status === 200)).toBe(true);
    expect(again.ref.at(-1).body.removed).toBe(again.preview.body.reference.length);
    expect(await Entry().countDocuments({ tenant_id: A.tenantId, upload_id: before })).toBe(0);
    expect(await Entry().countDocuments({ tenant_id: A.tenantId })).toBe(again.preview.body.reference.length);
    expect((await PoItem().findOne({ tenant_id: A.tenantId, item_code: "FX-M7-1" }).lean()).master_price).toBe(3207.37);
    expect((await A.users.viewer.api.post(FIND, { text: "FX-M7-1" })).body.results[0].entry.master_price).toBe(3300);
    // now tick BMP71 too → its catalogs (incl. FX-M7-1) are updated as before
    const third = await upload(A.users.pricer, changed, { tick: ["M210", "BMP71  M710"] });
    expect(third.preview.body.summary).toMatchObject({ update: 1, new: 1 }); // FX-M7-1 updated, FX-OLD-7 new
    expect((await PoItem().findOne({ tenant_id: A.tenantId, item_code: "FX-M7-1" }).lean()).master_price).toBe(3300);
  });

  test("ticking only a non-first sheet: series = its home sheet among the ticked ones", async () => {
    const T = await S.seedTenant("S6TICK");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const r = await upload(T.users.pricer, sheets(), { tick: ["BMP71  M710"] });
    expect(r.preview.body.records.map((x) => [x.item_code, x.category, x.price_sheet]).sort()).toEqual([
      ["FX-M7-1", "BMP71 M710", "New Replacement Part M611 M710"],
      ["FX-OLD-7", "BMP71 M710", "BMP71  M710"],
    ]);
  });
});

describe("S6 NEGATIVE", () => {
  test("empty / 201 pasted / too long → 400 with the field", async () => {
    expect((await A.users.viewer.api.post(FIND, { text: "  \n , " })).body).toEqual({ message: "Type a catalog no. (or Y code / obsolete catalog no.)", field: "text" });
    expect((await A.users.viewer.api.post(FIND, {})).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => `C-${i}`).join("\n");
    expect((await A.users.viewer.api.post(FIND, { text: many })).body).toEqual({ message: "Paste at most 200 catalog nos. at a time (201 given)", field: "text" });
    expect((await A.users.pricer.api.post(ADD, { text: many })).status).toBe(400);
    expect((await A.users.viewer.api.post(FIND, { text: { $ne: "" } })).status).toBe(400);
  });
  test("200 unknown catalogs → 200 all not_found", async () => {
    const r = await A.users.viewer.api.post(FIND, { text: Array.from({ length: 200 }, (_, i) => `UNKNOWN-${i}`).join(",") });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ found: 0, already: 0, not_found: 200 });
  });
  test("no reference uploaded yet → 400 'Upload the price list first' (find + add)", async () => {
    expect((await B.users.viewer.api.post(FIND, { text: "FX-M7-1" })).body).toEqual({ message: "Upload the price list first", code: "no_reference" });
    expect((await B.users.pricer.api.post(ADD, { text: "FX-M7-1" })).body).toEqual({ message: "Upload the price list first", code: "no_reference" });
    expect((await B.users.viewer.api.get(`${PL_PATH}/reference`)).body).toEqual({ count: 0, file_name: "", uploaded_at: null });
  });
  test("other company: B uploads only its own list — never finds A's catalogs; A's items untouched", async () => {
    const own = [{ name: "BOnly", rows: [["Catalog No", "MDP", "DP", "EP"], ["B-ONLY-1", 1, 2, 3]] }];
    const r = await upload(B.users.pricer, own);
    expect(r.ref[0].body).toMatchObject({ count: 1 });
    const f = (await B.users.viewer.api.post(FIND, { text: "FX-M7-1\nB-ONLY-1" })).body;
    expect(f.results.map((x) => x.status)).toEqual(["not_found", "already"]);
    // A's reference was not replaced by B's upload
    expect((await A.users.viewer.api.post(FIND, { text: "FX-M5-2" })).body.results[0].status).toBe("found");
    expect((await A.users.viewer.api.post(FIND, { text: "B-ONLY-1" })).body.results[0].status).toBe("not_found");
  });
  test("permissions: reference save / add need Manage Prices (403); tenant without the add-on → 403", async () => {
    const body = { upload_id: crypto.randomUUID(), entries: [{ item_code: "X-1", master_price: 1 }], done: true };
    expect((await A.users.maker.api.post(`${PL_PATH}/reference`, body)).status).toBe(403);
    expect((await A.users.approver.api.post(ADD, { text: "FX-M5-2" })).status).toBe(403);
    expect((await C.users.admin.api.post(FIND, { text: "FX-M5-2" })).status).toBe(403);
    expect((await C.users.admin.api.post(`${PL_PATH}/reference`, body)).status).toBe(403);
  });
  test("reference batches: bad upload id / not a list / > 2000 / nothing / bad record → 400 or reported; nothing switched", async () => {
    const pr = A.users.pricer.api;
    const before = (await pr.get(`${PL_PATH}/reference`)).body;
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: "x", entries: [] })).body.message).toBe("upload_id is missing or not valid");
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: "abc$def-12345", entries: [] })).status).toBe(400);
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: crypto.randomUUID(), entries: "x" })).body.message).toBe("entries must be a list");
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: crypto.randomUUID(), entries: Array.from({ length: 2001 }, (_, i) => ({ item_code: `Z-${i}` })) })).body.message).toBe("Send at most 2000 entries per batch");
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: crypto.randomUUID(), entries: [] })).body.message).toBe("Nothing to save");
    expect((await pr.post(`${PL_PATH}/reference`, { upload_id: crypto.randomUUID(), entries: [], done: true })).body.message).toBe("The price list has no items to keep");
    const id = crypto.randomUUID();
    const part = await pr.post(`${PL_PATH}/reference`, { upload_id: id, entries: [{ item_code: "OK-1", master_price: 5 }, { item_code: "BAD-1", y_code: "Y1" }, { master_price: 1 }] });
    expect(part.body).toEqual({ saved: 1, errors: [expect.objectContaining({ index: 1, error: "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)" }), expect.objectContaining({ index: 2, error: "No catalog or Y code" })] });
    // not "done" → the current reference is still the old one
    expect((await pr.get(`${PL_PATH}/reference`)).body).toEqual(before);
    expect((await pr.post(FIND, { text: "OK-1" })).body.results[0].status).toBe("not_found");
  });
  test("preview: a sheet left out with a bad mapping / series / header row is ignored, not a 400", async () => {
    const s = [
      { name: "Good", rows: [["Catalog No", "MDP", "DP", "EP"], ["G-1", 1, 2, 3]], include: true },
      { name: "Left out", rows: [["Catalog No", "MDP"], ["L-1", 1]], include: false, fields: ["catalog", "evil"], series: "Bad & name", header_row: 99 },
    ];
    const r = await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets: s });
    expect(r.status).toBe(200);
    expect(r.body.records.map((x) => x.item_code)).toEqual(["G-1"]);
    expect(r.body.reference.map((x) => [x.item_code, x.category])).toEqual([["G-1", "Good"], ["L-1", "Left out"]]);
    // the same problems on a TICKED sheet are still 400
    expect((await A.users.pricer.api.post(`${PL_PATH}/preview`, { sheets: [{ ...s[1], include: true }] })).status).toBe(400);
  });
});

describe("INTEGRATION — real F2 copy", () => {
  realTest("defaults → exactly 77 PO items (M210) + 6,152 in the reference → add M7-84-499 → PO → submit → Yes; Delete reason with a proforma", async () => {
    const XLSX = require("xlsx");
    const f2 = PLFX.rowsOf(XLSX.write(XLSX.read(fs.readFileSync(F2), { type: "buffer" }), { type: "buffer", bookType: "xlsx" }));
    const T = await S.seedTenant("R30F2");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const t0 = Date.now();
    const up = await upload(T.users.pricer, f2, { fileName: "PRICE LIST SFI AND HPI FY 27.xlsx" });
    console.log("[record] R30 F2 default upload ms", Date.now() - t0, "summary", JSON.stringify(up.preview.body.summary), "reference batches", up.ref.length);
    expect(up.preview.body.sheets.filter((s) => s.included).map((s) => s.name)).toEqual(["M210"]);
    expect(up.preview.body.summary).toMatchObject({ new: 77, total: 77, reference: 6141 });
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    expect(up.ref.every((r) => r.status === 200)).toBe(true);
    expect(up.ref.at(-1).body).toMatchObject({ done: true, count: 6141 });
    expect(await PoItem().countDocuments({ tenant_id: T.tenantId, category: { $ne: "" } })).toBe(77);
    const ser = (await T.users.viewer.api.get(`${P}/items/series`)).body;
    expect(ser.series.filter((s) => s.name !== "")).toEqual([{ name: "M210", count: 77 }]);
    expect(ser).toMatchObject({ resolved: "M210", reference: { count: 6141 } });

    // + Add Catalog No.: M7-84-499 (and the obsolete M71-R4300 → M7-R4300)
    const f = (await T.users.pricer.api.post(FIND, { text: "M7-84-499\nM71-R4300" })).body;
    expect(f.results.map((r) => [r.status, r.via, r.entry.item_code])).toEqual([["found", "catalog", "M7-84-499"], ["found", "obsolete", "M7-R4300"]]);
    const added = (await T.users.pricer.api.post(ADD, { text: "M7-84-499\nM71-R4300" })).body;
    expect(added.added).toBe(2);
    const m7 = await PoItem().findOne({ tenant_id: T.tenantId, item_code: "M7-84-499" }).lean();
    expect(m7).toMatchObject({ y_code: "Y5075406", master_price: 3207.37, distributor_price: 3690.88, end_customer_price: 4613.6, category: "BMP71 M710", price_sheet: "New Replacement Part M611 M710" });

    // use it on a PO → submit → Yes
    const po = (await T.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(T.customers.c1._id), items: [S.line(m7, 2, { selling_price: 5000 })], submit: true })).body;
    expect(po).toMatchObject({ status: "pending_approval", po_number: `PPO/01/${fy}` });
    expect(po.items.map((l) => [l.item_code, l.qty, l.rate, l.amount])).toEqual([["M7-84-499", 2, 3207, 6414]]);
    expect(po.totals).toMatchObject({ subtotal: 6414, tax_total: 1154.52, grand_total: 7568.52 });
    expect((await T.users.approver.api.post(`${P}/${po._id}/approve`, {})).body.status).toBe("approved");
    // INFO fix: approved + proforma → the Delete answer gives both reasons
    expect((await T.users.maker.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(201);
    const del = await T.users.full.api.del(`${P}/${po._id}`);
    expect(del).toEqual({ status: 400, body: { message: "Approved POs are locked · has a proforma invoice. Only draft or cancelled POs can be deleted" } });
  });
});
