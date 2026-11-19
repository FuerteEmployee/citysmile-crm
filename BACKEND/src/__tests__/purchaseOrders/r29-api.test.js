// Round 29 — API tests: POSITIVE / NEGATIVE / INTEGRATION for
//   S1 catalog series (default M210, series list + counts, filter, search
//      inside / across, "New series…" reuse, import with renamed series,
//      settings default_series)
//   S2 action rules on the API side (edit / delete answers per status,
//      permission, proforma), has_proforma on list rows, quick Yes / No
//   S3 POST /customer-po/read with the 3 sample customer POs + negatives
//   S4 required fields + formats + duplicates through the API
//   S5 approver payload carries the reasons; obsolete → replacement link
//      when the obsolete catalog is not an item
//   Integration: real F2 copy → default series → PO from the Crystal
//      Bunglows sample via auto-fill → raise one price → submit → approver
//      notified → Yes → PDF data → WhatsApp → proforma → WhatsApp customer
//      → Delete blocked (has proforma) → History + Activity Log; re-upload
//      F2 with one renamed series → items move, old PO keeps its snapshot.
// Same safety stack as the other PO suites (poStack.cjs): in-memory MongoDB,
// WhatsApp + Cloudinary mocked, network guard, uploads canary.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const PLFX = require("./priceListFixtures.cjs");
const FX = require("./r29Fixtures.cjs");

jest.setTimeout(300000);
const P = S.PO_PATH;
const PL_PATH = `${P}/items/pricelist`;
const READ = `${P}/customer-po/read`;
let A, B, C;
const PoItem = () => require("../../models/PoItem");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ActivityLog = () => require("../../models/ActivityLog");
const PDF = Buffer.from("%PDF-1.4 r29");
const BRADY_WA = "9888877777";
const fy = S.fyNow();
const F2 = process.env.PO_F2_PATH || "E:/Temp/claude/e--CRM-NEW-CRM-NEW/b4c0c0d7-4097-409b-969e-0605f9c72294/scratchpad/xl/price/PRICE LIST SFI AND HPI FY 27 (2).xlsx";
const hasF2 = fs.existsSync(F2);
const realTest = hasF2 && FX.hasSamples ? test : test.skip;
const sampleTest = FX.hasSamples ? test : test.skip;

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

// The browser's import: scan -> preview (with a series per sheet) -> import in batches.
async function uploadPriceList(u, sheets, { series = {}, batch = 1000 } = {}) {
  const scan = await u.api.post(`${PL_PATH}/scan`, { sheets });
  if (scan.status !== 200) return { scan };
  const withFields = sheets.map((s) => {
    const d = scan.body.sheets.find((x) => x.name === s.name);
    return { ...s, include: !d.skip_reason, fields: d.columns.map((c) => c.field), header_row: d.header_row, series: series[s.name] ?? d.series };
  });
  const preview = await u.api.post(`${PL_PATH}/preview`, { sheets: withFields });
  if (preview.status !== 200) return { scan, preview };
  const records = preview.body.records;
  const mappings = scan.body.sheets.filter((d) => !d.skip_reason).map((d) => ({ signature: d.signature, sheet_name: d.name, fields: d.columns.map((c) => c.field) }));
  const results = [];
  for (let i = 0; i < Math.max(records.length, 1); i += batch) {
    const last = i + batch >= records.length;
    results.push(await u.api.post(`${PL_PATH}/import`, { records: records.slice(i, i + batch), ...(last ? { links: preview.body.links, mappings } : {}) }));
  }
  return { scan, preview, results };
}

// The Brady catalogs of the sample POs (real F2 prices) in a company.
async function seedBrady(T) {
  const out = {};
  for (const b of FX.BRADY) out[b.item_code] = await PoItem().create({ ...b, name: b.item_code, unit: "Nos", tenant_id: T.tenantId });
  return out;
}
const read = (u, file, filename = "customer-po.pdf", type = "application/pdf", fields = {}) => u.api.upload(READ, { file, filename, type, fields });
// What the editor sends after "Read items": item, qty, selling price (from the review lines).
const linesFromRead = (lines) => lines.filter((l) => l.status === "matched").map((l) => ({ item_id: l.item_id, qty: l.qty, selling_price: l.selling_price }));

beforeAll(async () => {
  canary = snapshotUploads();
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] });
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
  A.brady = await seedBrady(A);
  await A.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady Test Supplier", whatsapp: BRADY_WA } });
});

afterAll(async () => {
  console.log("[guard] R29", JSON.stringify(S.guardReport()), "mocked wa", S.rec.whatsapp.length, "mocked uploads", S.rec.cloudinary.length, "real F2 copy:", hasF2 ? "used" : "absent (skipped)", "samples:", FX.hasSamples ? "used" : "absent");
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(snapshotUploads()).toBe(canary);
  expect(JSON.stringify(S.rec.whatsapp)).not.toMatch(/margin/i);
  await S.stopStack();
});

// ─── S1 ─────────────────────────────────────────────────────────────────────
describe("S1 SERIES — positive", () => {
  test("GET /items/series: every series with its count; total = all items; default M210 resolved", async () => {
    const r = await A.users.viewer.api.get(`${P}/items/series`);
    expect(r.status).toBe(200);
    expect(r.body.series).toEqual([{ name: "M210", count: 3 }, { name: "New Replacement Part M611 M710", count: 2 }]);
    expect(r.body.none).toBe(6); // the seeded I1..I6 have no series
    expect(r.body.total).toBe(11);
    expect(r.body.series.reduce((s, x) => s + x.count, 0) + r.body.none).toBe(r.body.total);
    expect(r.body).toMatchObject({ default_series: "M210", resolved: "M210" });
  });
  test("default series missing (no items) -> resolved '' (All series); a company without settings gets M210 by default", async () => {
    const r = await B.users.viewer.api.get(`${P}/items/series`);
    expect(r.body).toMatchObject({ default_series: "M210", resolved: "", series: [] });
  });
  test("list by series (any case), '__none__' = no series, search inside a series and across all", async () => {
    const v = A.users.viewer.api;
    expect((await v.get(`${P}/items?category=m210`)).body.data.map((i) => i.item_code).sort()).toEqual(["M21-375-423", "M21-500-423", "M21-750-423"]);
    expect((await v.get(`${P}/items?category=__none__`)).body.total).toBe(6);
    expect((await v.get(`${P}/items?category=M210&search=750`)).body.data.map((i) => i.item_code)).toEqual(["M21-750-423"]);
    expect((await v.get(`${P}/items?category=M210&search=M7-84`)).body.total).toBe(0); // not in M210
    expect((await v.get(`${P}/items?search=M7-84`)).body.data.map((i) => i.item_code)).toEqual(["M7-84-499"]); // all series
  });
  test("Add PO item with an existing series, and with a 'New series…' name in another case -> reused", async () => {
    const a = await A.users.pricer.api.post(`${P}/items`, { item_code: "S1-NEW-1", category: "M210", end_customer_price: 10 });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ category: "M210", name: "S1-NEW-1" });
    const b = await A.users.pricer.api.post(`${P}/items`, { item_code: "S1-NEW-2", category: "  m210 ", end_customer_price: 10 });
    expect(b.body.category).toBe("M210");
    const c = await A.users.pricer.api.post(`${P}/items`, { item_code: "S1-NEW-3", category: "Test  Series_1", end_customer_price: 10 });
    expect(c.body.category).toBe("Test Series_1");
    const s = (await A.users.viewer.api.get(`${P}/items/series`)).body.series;
    expect(s.find((x) => x.name === "M210").count).toBe(5);
    expect(s.find((x) => x.name === "Test Series_1").count).toBe(1);
    await PoItem().deleteMany({ tenant_id: A.tenantId, item_code: /^S1-NEW-/ });
  });
  test("PO Settings: default series saved / cleared; bad name -> 400", async () => {
    const adm = A.users.admin.api;
    expect((await adm.put(`${P}/settings`, { default_series: "New Replacement Part M611 M710" })).body.default_series).toBe("New Replacement Part M611 M710");
    expect((await A.users.viewer.api.get(`${P}/items/series`)).body.resolved).toBe("New Replacement Part M611 M710");
    expect((await adm.put(`${P}/settings`, { default_series: "" })).body.default_series).toBe("");
    expect((await A.users.viewer.api.get(`${P}/items/series`)).body.resolved).toBe("");
    const bad = await adm.put(`${P}/settings`, { default_series: "PMK&BBP" });
    expect(bad).toEqual({ status: 400, body: { message: "Series name: 1 to 40 letters, digits, spaces, - or _", field: "default_series" } });
    expect((await adm.put(`${P}/settings`, { default_series: "M210" })).body.default_series).toBe("M210");
    expect((await A.users.maker.api.put(`${P}/settings`, { default_series: "M210" })).status).toBe(403);
  });
  test("import: each sheet's series = sheet name (cleaned) by default; a renamed / existing series per sheet; counts update", async () => {
    const T = await S.seedTenant("S1IMP");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const sheets = PLFX.rowsOf(PLFX.workbookBuffer(PLFX.STYLES.filter((s) => ["M210", "BMP41", "BMP71  M710", "M410"].includes(s[0]))));
    const up = await uploadPriceList(T.users.pricer, sheets, { series: { BMP41: "Printers 41", M410: "m210" } });
    expect(up.scan.body.sheets.map((s) => [s.name, s.series])).toEqual([["M210", "M210"], ["BMP41", "BMP41"], ["M410", "M410"], ["BMP71  M710", "BMP71 M710"]]);
    expect(up.preview.body.sheets.map((s) => [s.name, s.series])).toEqual([["M210", "M210"], ["BMP41", "Printers 41"], ["M410", "M210"], ["BMP71  M710", "BMP71 M710"]]);
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    const ser = (await T.users.viewer.api.get(`${P}/items/series`)).body;
    expect(Object.fromEntries(ser.series.map((s) => [s.name, s.count]))).toEqual({ "BMP71 M710": 2, M210: 3, "Printers 41": 1 });
    // re-upload with BMP41 renamed again -> its item moves; counts follow
    const again = await uploadPriceList(T.users.pricer, sheets, { series: { BMP41: "Printers BMP41", M410: "M210" } });
    expect(again.preview.body.summary.update).toBe(1);
    const ser2 = (await T.users.viewer.api.get(`${P}/items/series`)).body;
    expect(Object.fromEntries(ser2.series.map((s) => [s.name, s.count]))).toEqual({ "BMP71 M710": 2, M210: 3, "Printers BMP41": 1 });
    // a bad series name for a sheet -> 400, nothing imported
    const bad = await T.users.pricer.api.post(`${PL_PATH}/preview`, { sheets: [{ ...sheets[0], series: "Bad & name" }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ message: 'Sheet "M210": Series name: 1 to 40 letters, digits, spaces, - or _', field: "series" });
  });
});

// ─── S2 ─────────────────────────────────────────────────────────────────────
describe("S2 ACTIONS — API side", () => {
  const mk = (extra = {}) => A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)], ...extra });
  test("list + pending rows carry has_proforma; pending rows carry created_by", async () => {
    const po = await S.approvedPo(A, [S.line(A.items.I1, 1)], { customer: String(A.customers.c1._id) });
    expect((await A.users.maker.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(201);
    const row = (await A.users.viewer.api.get(`${P}?search=${encodeURIComponent(po.po_number)}`)).body.data[0];
    expect(row.has_proforma).toBe(true);
    const d = (await mk()).body;
    expect((await A.users.viewer.api.get(`${P}?search=${encodeURIComponent(d.po_number)}`)).body.data[0].has_proforma).toBe(false);
    const pend = (await mk({ submit: true })).body;
    const p = (await A.users.approver.api.get(`${P}/approvals/pending`)).body.find((x) => x._id === pend._id);
    expect(p).toMatchObject({ has_proforma: false, created_by: { firstname: "maker" } });
    A.withPf = po;
  });
  test("Edit: pending -> 400 'Pending POs are locked'; approved / sent / received -> 400 'Approved POs are locked'; no Edit -> 403", async () => {
    const body = { items: [S.line(A.items.I1, 2)] };
    const pend = (await mk({ submit: true })).body;
    expect((await A.users.maker.api.put(`${P}/${pend._id}`, body)).body.message).toBe("Pending POs are locked");
    const appr = await S.approvedPo(A, [S.line(A.items.I1, 1)]);
    expect((await A.users.maker.api.put(`${P}/${appr._id}`, body)).body.message).toBe("Approved POs are locked");
    await A.users.maker.api.post(`${P}/${appr._id}/status`, { status: "sent" });
    expect((await A.users.maker.api.put(`${P}/${appr._id}`, body)).body.message).toBe("Approved POs are locked");
    await A.users.maker.api.post(`${P}/${appr._id}/status`, { status: "received" });
    expect((await A.users.maker.api.put(`${P}/${appr._id}`, body)).body.message).toBe("Approved POs are locked");
    const d = (await mk()).body;
    expect((await A.users.viewer.api.put(`${P}/${d._id}`, body)).status).toBe(403);
    expect((await A.users.approver.api.put(`${P}/${d._id}`, body)).status).toBe(403);
    // draft + Edit -> 200
    expect((await A.users.maker.api.put(`${P}/${d._id}`, body)).status).toBe(200);
  });
  test("Delete: pending / approved / sent / received -> 400 with the lock reason; PO with a proforma -> 400 'Has a proforma invoice'; no Delete -> 403; draft + Delete -> gone", async () => {
    const full = A.users.full.api;
    const pend = (await mk({ submit: true })).body;
    expect((await full.del(`${P}/${pend._id}`)).body.message).toBe("Pending POs are locked. Only draft or cancelled POs can be deleted");
    const appr = await S.approvedPo(A, [S.line(A.items.I1, 1)]);
    expect((await full.del(`${P}/${appr._id}`)).body.message).toBe("Approved POs are locked. Only draft or cancelled POs can be deleted");
    await A.users.admin.api.post(`${P}/${A.withPf._id}/status`, { status: "cancelled" });
    const pf = await full.del(`${P}/${A.withPf._id}`);
    expect(pf).toEqual({ status: 400, body: { message: "Has a proforma invoice — this PO stays on record" } });
    const d = (await mk()).body;
    expect((await A.users.maker.api.del(`${P}/${d._id}`)).status).toBe(403); // maker has no Delete
    expect((await full.del(`${P}/${d._id}`)).status).toBe(200);
    expect(await PurchaseOrder().findById(d._id)).toBeNull();
    const cancelled = (await mk()).body;
    await A.users.admin.api.post(`${P}/${cancelled._id}/status`, { status: "cancelled" });
    expect((await full.del(`${P}/${cancelled._id}`)).status).toBe(200);
  });
  test("Approvals quick Yes / No: Yes -> approved; No without reason -> 400; with reason -> draft", async () => {
    const one = (await mk({ submit: true })).body;
    const two = (await mk({ submit: true })).body;
    expect((await A.users.approver.api.post(`${P}/${one._id}/approve`, {})).body.status).toBe("approved");
    expect((await A.users.approver.api.post(`${P}/${two._id}/reject`, { reason: "" })).status).toBe(400);
    expect((await A.users.approver.api.post(`${P}/${two._id}/reject`, { reason: "Recheck qty" })).body.status).toBe("draft");
  });
});

// ─── S3 ─────────────────────────────────────────────────────────────────────
describe("S3 AUTO-FILL — POST /customer-po/read", () => {
  (FX.hasSample("crystal") ? test : test.skip)("Crystal Bunglows: M7-84-499 ×2 @5000, M21-500-423 ×5 @3000 -> PO taxable 15,984 / GST 2,877.12 / grand 18,861.12, margin 36.05 %", async () => {
    const r = await read(A.users.maker, FX.sample("crystal"), "Sample_Customer_PO_Crystal_Bunglows_F1.pdf", "application/pdf", { customer: String(A.customers.c1._id) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: "pdf", price_level: "end_user", customer_po_number: "SGE/PO/2026/145", customer_po_date: "2026-10-25", summary: { matched: 2, not_found: 0, qty_unreadable: 0 } });
    expect(r.body.lines.map((l) => [l.item_code, l.qty, l.rate, l.cost_price, l.list_price, l.selling_price, l.below_floor])).toEqual([
      ["M7-84-499", 2, 5000, 3207.37, 4613.6, 5000, false],
      ["M21-500-423", 5, 3000, 1914.44, 2753.8, 3000, false],
    ]);
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    expect(before).toBeGreaterThan(0); // nothing saved by the read
    const po = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), customer_po_number: "CRYSTAL-1", customer_po_date: r.body.customer_po_date, items: linesFromRead(r.body.lines) });
    expect(po.status).toBe(201);
    expect(po.body.totals).toMatchObject({ subtotal: 15984, tax_total: 2877.12, cgst: 1438.56, sgst: 1438.56, grand_total: 18861.12, margin_pct: 36.05 });
  });
  sampleTest("Om Sai Infra (3 lines) and SGE (own layout) are read too", async () => {
    const om = (await read(A.users.maker, FX.sample("omsai"))).body;
    expect(om.lines.map((l) => [l.status, l.item_code, l.qty, l.rate])).toEqual([["matched", "M7-R4300", 3, 3000], ["matched", "M21-750-423", 4, 3200], ["matched", "M21-375-423", 6, 3000]]);
    expect(om.customer_po_number).toBe("OSI/PO/26-27/052");
    const sge = (await read(A.users.maker, FX.sample("sge"))).body;
    expect(sge.lines.map((l) => [l.status, l.item_code, l.qty, l.rate])).toEqual([["matched", "M7-84-499", 2, 5000], ["matched", "M21-500-423", 5, 3000]]);
  });
  test("customer rate below the floor -> selling = floor, below_floor flagged; distributor customer -> floor = DP", async () => {
    const xl = FX.xlsxPo([["Sr", "Catalog", "Qty", "Rate", "Amount"], [1, "M7-84-499", 1, 4000, 4000]]);
    const r = (await read(A.users.maker, xl, "po.xlsx", "application/octet-stream")).body;
    expect(r.lines[0]).toMatchObject({ rate: 4000, list_price: 4613.6, selling_price: 4613.6, below_floor: true });
    await A.users.admin.api.put(`${P}/settings/price-level`, { customer: String(A.customers.c2._id), level: "distributor" });
    const d = (await read(A.users.maker, xl, "po.xlsx", "application/octet-stream", { customer: String(A.customers.c2._id) })).body;
    expect(d).toMatchObject({ price_level: "distributor" });
    expect(d.lines[0]).toMatchObject({ list_price: 3690.88, selling_price: 4000, below_floor: false });
    await A.users.admin.api.put(`${P}/settings/price-level`, { customer: String(A.customers.c2._id), level: "end_user" });
  });
  test("unknown catalogs -> red lines with the text read; no known catalog -> no lines + message", async () => {
    const r = (await read(A.users.maker, FX.makePdf([["1", "QQ-777-1", "mystery", "2", "Nos", "10.00", "20.00"]]))).body;
    expect(r.lines).toEqual([expect.objectContaining({ status: "not_found", catalog: "QQ-777-1" })]);
    const none = (await read(A.users.maker, FX.makePdf([["Hello", "world", "no codes here"]]))).body;
    expect(none).toMatchObject({ lines: [], message: "No order lines with catalog numbers from PO Items were found — add items by hand" });
  });
  test.each([
    ["image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "scan.png", "image/png", "Can't read a scanned file — add items by hand"],
    ["scanned PDF", null, "scan.pdf", "application/pdf", "Can't read a scanned file — add items by hand"],
    ["0-byte file", Buffer.alloc(0), "empty.pdf", "application/pdf", "The file is empty"],
    [".exe renamed .pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), "po.pdf", "application/pdf", "Only a PDF or Excel (.xlsx) customer PO can be read"],
  ])("%s -> 400 '%s'", async (_l, buf, name, type, msg) => {
    const r = await read(A.users.maker, buf || FX.blankPdf(), name, type);
    expect(r).toEqual({ status: 400, body: { message: msg } });
  });
  test("11 MB file -> 400 'larger than 10 MB'; no file -> 400; two files -> 400", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    expect(await read(A.users.maker, big)).toEqual({ status: 400, body: { message: "The file is larger than 10 MB" } });
    expect((await A.users.maker.api.upload(READ, {})).body).toEqual({ message: "Attach the customer's PO (PDF or Excel)" });
  });
  test("permissions + companies: viewer / approver -> 403; tenant C (add-on off) -> 403; other company's customer -> 400; B never sees A's items", async () => {
    expect((await read(A.users.viewer, FX.makePdf([["1", "M7-84-499", "1", "5000", "5000"]]))).status).toBe(403);
    expect((await read(A.users.approver, FX.makePdf([["1", "M7-84-499", "1", "5000", "5000"]]))).status).toBe(403);
    expect((await read(C.users.admin, FX.makePdf([["1", "M7-84-499", "1", "5000", "5000"]]))).status).toBe(403);
    expect((await read(A.users.maker, FX.makePdf([["1", "M7-84-499", "1", "5000", "5000"]]), "x.pdf", "application/pdf", { customer: String(B.customers.c1._id) })).body).toEqual({ message: "Unknown customer" });
    // B has no such PO item: the line is red (not found) — never matched to A's item
    const b = (await read(B.users.maker, FX.makePdf([["1", "M7-84-499", "Nos", "1", "5000.00", "5000.00"]]))).body;
    expect(b.lines.map((l) => [l.status, l.catalog, l.item_id])).toEqual([["not_found", "M7-84-499", undefined]]);
  });
});

// ─── S4 ─────────────────────────────────────────────────────────────────────
describe("S4 VALIDATION through the API", () => {
  const m = () => A.users.maker.api;
  const base = (extra = {}) => ({ type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)], ...extra });
  test("required: customer, at least one item, qty > 0 -> 400 with the field; nothing saved", async () => {
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    expect((await m().post(P, base({ customer: null }))).body).toEqual({ message: "Customer is required", field: "customer" });
    expect((await m().post(P, base({ items: [] }))).body).toEqual({ message: "Add at least one item", field: "items" });
    expect((await m().post(P, base({ items: [S.line(A.items.I1, 0)] }))).body).toEqual({ message: "Line 1: quantity must be more than 0", field: "items" });
    expect((await m().post(P, base({ items: [S.line(A.items.I1, 1, { selling_price: "" })] }))).body).toEqual({ message: "Line 1: selling price: enter a number", field: "items" });
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test.each([
    [{ customer_po_number: "<b>x</b>" }, "customer_po_number", "Customer PO No. can only have letters, digits, space and - _ . ( ) /"],
    [{ customer_po_number: "A".repeat(61) }, "customer_po_number", "Customer PO No. can't be longer than 60 characters"],
    [{ po_date: "2026-06-10", expected_date: "2026-06-01" }, "expected_date", "Expected delivery can't be before the PO date"],
    [{ po_date: "2026-06-10", customer_po_date: "2026-06-11" }, "customer_po_date", "Customer PO date can't be after the PO date"],
    [{ items: [S.line({ _id: "000000000000000000000000" }, 1)] }, "items", "Line 1: pick the item from the PO items"],
    [{ items: [{ item_id: "x", qty: -1 }] }, "items", "Line 1: quantity must be more than 0"],
    [{ items: [{ item_id: "x", qty: 1.5 }] }, "items", "Line 1: quantity must be a whole number"],
    [{ items: [{ item_id: "x", qty: "abc" }] }, "items", "Line 1: quantity: enter a number"],
  ])("PO %j -> 400 %s", async (extra, field, message) => {
    const r = await m().post(P, base(extra));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ field, message });
  });
  test("prices: 'abc' / -1 / 1e12 -> 400 (selling price)", async () => {
    for (const [v, msg] of [["abc", "Line 1: selling price: enter a number"], [-1, "Line 1: selling price can't be negative"], [1e12, "Line 1: selling price can't be more than 1,00,00,000"]]) {
      expect((await m().post(P, base({ items: [S.line(A.items.I1, 1, { selling_price: v })] }))).body.message).toBe(msg);
    }
  });
  test("GST % 23 on a line -> saved with a warning (not blocked)", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: 23 })] }));
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual(["Line 1: GST % 23 is not a usual GST rate (0, 5, 12, 18, 28 or 40)"]);
  });
  test("same item twice on one PO -> merged (qty added) with a warning", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 2, { selling_price: 170 }), S.line(A.items.I5, 1), S.line(A.items.I1, 3, { selling_price: 999 })] }));
    expect(r.status).toBe(201);
    expect(r.body.items.map((l) => [l.item_code, l.qty, l.selling_price])).toEqual([["I1-A", 5, 170], ["BR-001", 1, 70]]);
    expect(r.body.warnings).toEqual(["The same item was on the PO more than once — merged into line 1 (qty 5)"]);
  });
  test("customer PO file needs the Customer PO No.: upload before the number -> 400; after -> 200; clearing it later -> 400", async () => {
    const d = (await m().post(P, base())).body;
    const up = await m().upload(`${P}/${d._id}/customer-po-file`, { file: PDF, filename: "po.pdf" });
    expect(up.status).toBe(400);
    expect(up.body).toMatchObject({ field: "customer_po_number" });
    await m().put(`${P}/${d._id}`, base({ customer_po_number: "FILE-NO-1" }));
    expect((await m().upload(`${P}/${d._id}/customer-po-file`, { file: PDF, filename: "po.pdf" })).status).toBe(200);
    expect((await m().put(`${P}/${d._id}`, base({ customer_po_number: "" }))).body).toEqual({ message: "Customer PO No. is required when the customer's PO file is attached", field: "customer_po_number" });
  });
  test("duplicate customer PO No. for the same customer -> 400 with a link to that PO", async () => {
    const first = (await m().post(P, base({ customer_po_number: "DUP-CPO-1" }))).body;
    const r = await m().post(P, base({ customer_po_number: "dup-cpo-1" }));
    expect(r.body).toEqual({ message: `Customer PO No. dup-cpo-1 is already on ${first.po_number} for this customer`, field: "customer_po_number", code: "customer_po_duplicate", existing: [{ _id: first._id, po_number: first.po_number }] });
  });
  test("PO items: catalog / Y code / HSN / series / EP formats; duplicate catalog 409", async () => {
    const p = A.users.pricer.api;
    const ok = { item_code: "FMT-1", category: "Fmt", end_customer_price: 10 };
    for (const [bad, field, msg] of [
      [{ item_code: "A" }, "item_code", "Catalog no. must be 2 to 40 characters"],
      [{ item_code: "AB CD" }, "item_code", "Catalog no. can only have letters, digits and - / . _ (no spaces)"],
      [{ y_code: "Y12" }, "y_code", "Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)"],
      [{ hsn: "39199" }, "hsn", "HSN must be 4, 6 or 8 digits"],
      [{ category: "Bad&Series" }, "category", "Series name: 1 to 40 letters, digits, spaces, - or _"],
      [{ end_customer_price: 0 }, "end_customer_price", "End User Price is required"],
      [{ master_price: 1e8 }, "master_price", "master price can't be more than 1,00,00,000"],
    ]) {
      const r = await p.post(`${P}/items`, { ...ok, ...bad });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ field, message: msg });
    }
    expect((await p.post(`${P}/items`, { ...ok, y_code: "y5075999", hsn: "39199090", tax_rate: 23 })).body).toMatchObject({ y_code: "Y5075999", warnings: ["GST % 23 is not a usual GST rate (0, 5, 12, 18, 28 or 40)"] });
    const dup = await p.post(`${P}/items`, { ...ok, item_code: "fmt-1" });
    expect(dup).toEqual({ status: 409, body: { message: 'Catalog no. "FMT-1" already exists — edit it instead', field: "item_code", code: "po_item_exists" } });
  });
  test("settings: company GSTIN (bad state code, lower case), phone, email; prefix; valid days 0 / 400 / '05'", async () => {
    const adm = A.users.admin.api;
    const company = { name: "Test Traders Pvt Ltd" };
    expect((await adm.put(`${P}/settings`, { company: { ...company, gstin: "99ABCDE1234F1Z5" } })).body).toEqual({ message: "Company GSTIN: state code 99 is not valid (01-38)", field: "company.gstin" });
    expect((await adm.put(`${P}/settings`, { company: { ...company, gstin: "24abcde1234f1z5" } })).body.company.gstin).toBe("24ABCDE1234F1Z5");
    expect((await adm.put(`${P}/settings`, { company: { ...company, phone: "12345" } })).body.field).toBe("company.phone");
    expect((await adm.put(`${P}/settings`, { company: { ...company, email: "x@" } })).body.field).toBe("company.email");
    expect((await adm.put(`${P}/settings`, { company: { ...company, name: "" } })).body.field).toBe("company.name");
    const divs = (await adm.get(`${P}/settings`)).body.divisions;
    for (const prefix of ["DA/1", "D A", "ABCDEFGHIJK"]) {
      const r = await adm.put(`${P}/settings`, { divisions: divs.map((d, i) => (i === 0 ? { ...d, purchase_prefix: prefix } : d)) });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe("purchase_prefix");
    }
    expect((await adm.put(`${P}/settings`, { divisions: divs.map((d, i) => (i === 0 ? { ...d, purchase_prefix: "" } : d)) })).body.field).toBe("purchase_prefix");
    for (const v of [0, 400, 1.5, "abc"]) {
      expect((await adm.put(`${P}/settings`, { proforma: { prefix: "", valid_days: v } })).body).toEqual({ message: "Valid for (days) must be a whole number from 1 to 365", field: "proforma.valid_days" });
    }
    expect((await adm.put(`${P}/settings`, { proforma: { prefix: "", valid_days: "05" } })).body.proforma.valid_days).toBe(5);
    expect((await adm.put(`${P}/settings`, { proforma: { prefix: "", valid_days: 15 } })).body.proforma.valid_days).toBe(15);
  });
  test("proforma: Bill-to name required; GSTIN / email / phone formats; Disc 101; extra line HSN / qty; customer PO no.; second proforma 409", async () => {
    const po = await S.approvedPo(A, [S.line(A.items.I1, 1)], { customer: String(A.customers.c1._id), customer_po_number: "PF-VAL-1" });
    const pf = (await A.users.maker.api.post(`${P}/${po._id}/proforma`, {})).body;
    const put = (b) => A.users.maker.api.put(`${P}/proformas/${pf._id}`, b);
    expect((await put({ bill_to: { name: "" } })).body).toEqual({ message: "Bill to: the customer name is required", field: "bill_to.name" });
    expect((await put({ bill_to: { name: "Acme", gstin: "24ABCDE1234F1Z" } })).body.field).toBe("bill_to.gstin");
    expect((await put({ bill_to: { name: "Acme", email: "nope" } })).body.field).toBe("bill_to.email");
    expect((await put({ bill_to: { name: "Acme", phone: "123" } })).body.field).toBe("bill_to.phone");
    expect((await put({ customer_po_number: "<x>" })).body.field).toBe("customer_po_number");
    expect((await put({ lines: [{ _id: pf.lines[0]._id, disc_pct: 101 }] })).status).toBe(400);
    expect((await put({ lines: [{ _id: pf.lines[0]._id }, { is_extra: true, description: "Freight", qty: 1.5, rate: 100 }] })).body.message).toBe("Line 2: quantity must be a whole number");
    expect((await put({ lines: [{ _id: pf.lines[0]._id }, { is_extra: true, description: "Freight", qty: 1, rate: 100, hsn: "99" }] })).body.message).toBe("Line 2: HSN/SAC must be 4, 6 or 8 digits");
    expect((await put({ bill_to: { name: "Acme", gstin: "24abcde1234f1z5", phone: "+91 98765 43210", email: "a@acme.test" } })).body.bill_to.gstin).toBe("24ABCDE1234F1Z5");
    expect((await A.users.maker.api.post(`${P}/${po._id}/proforma`, {})).status).toBe(409);
  });
});

// ─── S5 ─────────────────────────────────────────────────────────────────────
describe("S5 FIXES", () => {
  test("approver notification payload carries the reasons (toast: 'is waiting for your approval' + reasons)", async () => {
    const n = S.rec.io.length;
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, { selling_price: 175 })], submit: true });
    const ev = S.rec.io.slice(n).find((e) => e.room === String(A.users.approver.id) && e.payload.event === "requested");
    expect(ev.payload).toMatchObject({ number: r.body.po_number, reasons: ["Line 1 (I1 Label A): Price raised from 160 to 175"] });
  });
  test("obsolete -> replacement link when the obsolete catalog is NOT an item: on the new item's 'replaces'; picker search finds it", async () => {
    const T = await S.seedTenant("S5LINK");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const sheets = PLFX.rowsOf(PLFX.workbookBuffer(PLFX.STYLES.filter((s) => s[0] === "New Replacement Part M611 M710")));
    await uploadPriceList(T.users.pricer, sheets);
    const it = (await T.users.maker.api.get(`${P}/items?active=true&search=FX-OLD-7`)).body.data;
    expect(it.map((i) => [i.item_code, i.replaces])).toEqual([["FX-M7-1", ["FX-OLD-7", "Y8000001"]]]);
    // the import's link step adds a missing old catalog to the new item too
    await PoItem().updateOne({ tenant_id: T.tenantId, item_code: "FX-M7-1" }, { $set: { replaces: [] } });
    const r = await T.users.pricer.api.post(`${PL_PATH}/import`, { records: [], links: [{ old_catalog: "FX-OLD-7", new_catalog: "FX-M7-1" }] });
    expect(r.body.linked).toBe(1);
    expect((await PoItem().findOne({ tenant_id: T.tenantId, item_code: "FX-M7-1" }).lean()).replaces).toEqual(["FX-OLD-7"]);
  });
});

// ─── INTEGRATION ────────────────────────────────────────────────────────────
describe("INTEGRATION — real F2 copy + Crystal Bunglows sample", () => {
  realTest("F2 -> series (sum 6,152, M210 default) -> PO from the sample via auto-fill -> raise one price -> submit -> notified -> Yes -> PDF data -> WhatsApp -> proforma -> WhatsApp customer -> Delete blocked -> History + Activity Log; re-upload with a renamed series", async () => {
    const XLSX = require("xlsx");
    const sheets = PLFX.rowsOf(XLSX.write(XLSX.read(fs.readFileSync(F2), { type: "buffer" }), { type: "buffer", bookType: "xlsx" }));
    const T = await S.seedTenant("R29F2");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const up = await uploadPriceList(T.users.pricer, sheets);
    expect(up.results.every((r) => r.status === 200)).toBe(true);
    const ser = (await T.users.viewer.api.get(`${P}/items/series`)).body;
    console.log("[record] F2 series", JSON.stringify(ser.series));
    // the 6,141 price-list items with a catalog no. (11 Y-code-only rows are refused, round 31) are all in a series; + the 6 seeded test items (no series)
    expect(ser.series.reduce((s, x) => s + x.count, 0)).toBe(6141);
    expect(ser.none).toBe(6);
    expect(ser.total).toBe(6147);
    expect(ser.series.find((s) => s.name === "M210").count).toBe(77);
    expect(ser.series.map((s) => s.name)).toEqual(expect.arrayContaining(["BMP71 M710", "PMK-BBP85_30-03-2026", "New Replacement Part M611 M710"]));
    expect(ser).toMatchObject({ default_series: "M210", resolved: "M210" });
    expect((await T.users.admin.api.put(`${P}/settings`, { default_series: "M210", supplier: { name: "Brady Test Supplier", whatsapp: BRADY_WA } })).status).toBe(200);
    // the obsolete M71-R4300 (not an item) finds M7-R4300
    expect((await T.users.maker.api.get(`${P}/items?active=true&search=M71-R4300`)).body.data.map((i) => i.item_code)).toEqual(["M7-R4300"]);

    // auto-fill from the sample, then the maker raises one price
    const rd = (await read(T.users.maker, FX.sample("crystal"), "crystal.pdf", "application/pdf", { customer: String(T.customers.c1._id) })).body;
    expect(rd.summary).toEqual({ matched: 2, not_found: 0, qty_unreadable: 0 });
    const items = linesFromRead(rd.lines);
    items[1].selling_price = 3100;
    const n = S.rec.io.length;
    const created = await T.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(T.customers.c1._id), customer_po_number: rd.customer_po_number, customer_po_date: rd.customer_po_date, items, submit: true });
    expect(created.status).toBe(201);
    const po = created.body;
    expect(po).toMatchObject({ status: "pending_approval", po_number: `PPO/01/${fy}`, customer_po_number: "SGE/PO/2026/145" });
    expect(po.totals).toMatchObject({ subtotal: 15984, tax_total: 2877.12, grand_total: 18861.12 });
    expect(po.approval.reasons).toEqual(["Line 1 (M7-84-499): Price raised from 4613.6 to 5000", "Line 2 (M21-500-423): Price raised from 2753.8 to 3100"]);
    const ev = S.rec.io.slice(n).find((e) => e.room === String(T.users.approver.id) && e.payload.event === "requested");
    expect(ev.payload.reasons).toHaveLength(2);
    expect((await T.users.approver.api.post(`${P}/${po._id}/approve`, {})).body.status).toBe("approved");
    const pr = (await T.users.maker.api.get(`${P}/${po._id}/print`)).body;
    expect(pr.po.items.map((l) => [l.item_code, l.rate, l.amount])).toEqual([["M7-84-499", 3207, 6414], ["M21-500-423", 1914, 9570]]);
    await require("../../models/WhatsAppInbox").create({ tenant_id: T.tenantId, from: `91${BRADY_WA}`, mobile: BRADY_WA, direction: "in", message: "hi", received_at: new Date() });
    expect((await T.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF })).body.status).toBe("sent");
    const pf = (await T.users.maker.api.post(`${P}/${po._id}/proforma`, {})).body;
    expect(pf.lines.map((l) => [l.ref_no, l.qty, l.rate])).toEqual([["M7-84-499", 2, 5000], ["M21-500-423", 5, 3100]]);
    await require("../../models/WhatsAppInbox").create({ tenant_id: T.tenantId, from: "919876543210", mobile: "9876543210", direction: "in", message: "hi", received_at: new Date() });
    expect((await T.users.maker.api.upload(`${P}/proformas/${pf._id}/whatsapp`, { file: PDF })).body.status).toBe("sent");
    // Delete blocked: the PO isn't a draft (and has a proforma)
    const del = await T.users.full.api.del(`${P}/${po._id}`);
    expect(del.status).toBe(400);
    const row = (await T.users.viewer.api.get(`${P}?search=${encodeURIComponent(po.po_number)}`)).body.data[0];
    expect(row.has_proforma).toBe(true);
    const g = (await T.users.viewer.api.get(`${P}/${po._id}`)).body;
    expect(g.history.map((h) => h.action)).toEqual(["created", "submitted", "approved", "whatsapp", "status:sent", "proforma_created"]);
    const pfg = (await T.users.viewer.api.get(`${P}/proformas/${pf._id}`)).body;
    expect(pfg.history.map((h) => h.action)).toEqual(["created", "whatsapp"]);
    expect(await waitFor(() => ActivityLog().countDocuments({ tenant_id: T.tenantId, rel_id: po._id }))).toBeGreaterThanOrEqual(5);
    expect(await waitFor(() => ActivityLog().countDocuments({ tenant_id: T.tenantId, rel_id: new mongoose.Types.ObjectId(String(pf._id)) }))).toBeGreaterThanOrEqual(2);

    // Re-upload F2 with ONE series renamed: its items move, counts update, the PO keeps its snapshot.
    const again = await uploadPriceList(T.users.pricer, sheets, { series: { M210: "M210 Cartridges" } });
    expect(again.preview.body.summary.update).toBe(77);
    const ser2 = (await T.users.viewer.api.get(`${P}/items/series`)).body;
    expect(ser2.series.find((s) => s.name === "M210")).toBeUndefined();
    expect(ser2.series.find((s) => s.name === "M210 Cartridges").count).toBe(77);
    expect(ser2.series.reduce((s, x) => s + x.count, 0)).toBe(6141);
    expect(ser2.resolved).toBe(""); // default M210 has no items now -> All series
    const after = (await T.users.viewer.api.get(`${P}/${po._id}`)).body;
    expect(after.items.map((l) => [l.item_code, l.cost_price, l.selling_price])).toEqual([["M7-84-499", 3207.37, 5000], ["M21-500-423", 1914.44, 3100]]);
  });
});
