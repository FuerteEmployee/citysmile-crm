// PART 5 — PO Items (was "Price List"): GET /items, preview, import, PUT /items/:itemId.
// G0 moved the price master off the CRM Item model onto PoItem; the routes moved
// from /price-list to /items. Same cases, now against PoItem.
// "[BUG]" / "[RECORD]" / "[QUESTION]" tests assert the CURRENT behaviour.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const mongoose = require("mongoose");
const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
let A, B;
const Item = () => require("../../models/PoItem"); // the PO price master (G0)
const CrmItem = () => require("../../models/Item");
const ActivityLog = () => require("../../models/ActivityLog");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const preview = (u, rows) => u.api.post(`${P}/items/import/preview`, { rows });
const importRows = (u, rows) => u.api.post(`${P}/items/import`, { rows });
// priceNum through the preview endpoint (cost_price of an existing item)
const parse = async (value) => {
  const r = await preview(A.users.pricer, [{ item_code: "I1-A", cost_price: value }]);
  const row = r.body.rows[0];
  if (row.status === "error") return { error: row.error };
  return { value: row.changes.cost_price ? row.changes.cost_price.to : 100 };
};

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] PART5", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, wa: S.rec.whatsapp.length, cloud: S.rec.cloudinary.length }));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("5.1 UNIT — priceNum + matchPriceRows (via preview)", () => {
  test.each([
    ["1,250", 1250],
    ["₹ 1,250.50", 1250.5],
    ["12.345", 12.35],
    [" 99 ", 99],
    [0, 0],
    ["Rs. 1,250", 1250],
    ["rs 99.5", 99.5],
    ["INR 2,000", 2000],
    ["₹500", 500],
    [12.5, 12.5],
    ["0", 0],
  ])("priceNum(%p) -> %p", async (input, out) => {
    expect(await parse(input)).toEqual({ value: out });
  });
  test.each([["-5"], [-1], ["1.2.3"], ["5-"], ["--5"], ["$100"], [".5"], ["5."], ["1 000"], ["₹-5"]])("priceNum(%p) -> error row", async (input) => {
    expect((await parse(input)).error).toBe("cost price is not a valid amount");
  });
  test("[FIXED] priceNum('1e5') -> error row (finding 5a, was 15)", async () => {
    expect(await parse("1e5")).toEqual({ error: "cost price is not a valid amount" });
  });
  test("[FIXED] priceNum('12abc') -> error row (finding 5a, was 12)", async () => {
    expect(await parse("12abc")).toEqual({ error: "cost price is not a valid amount" });
  });
  test("[FIXED] priceNum('abc') -> error row (was 0, wiping the price)", async () => {
    expect(await parse("abc")).toEqual({ error: "cost price is not a valid amount" });
  });
  test("blank / null / missing cell keeps the old price (finding 5b)", async () => {
    for (const v of ["", "   ", null, undefined]) {
      const r = await preview(A.users.pricer, [{ item_code: "I1-A", cost_price: v }]);
      expect(r.body.rows[0].status).toBe("unchanged");
    }
  });
  test("match by item code first (case-insensitive), else by name (case-insensitive) (finding 5b)", async () => {
    const r = await preview(A.users.pricer, [
      { item_code: "i1-a", cost_price: 101 },
      { name: "  i3 nolist a ", cost_price: 81 },
      { name: "Brand New", item_code: "NEW-1", cost_price: 5, end_customer_price: 9 },
      { item_code: "I5-unknown-code" },
      { name: "", item_code: "" },
    ]);
    const rows = r.body.rows;
    expect(rows.map((x) => x.status)).toEqual(["update", "update", "new", "error", "error"]);
    expect(rows.map((x) => x.row)).toEqual([2, 3, 4, 5, 6]);
    expect(rows[0]).toMatchObject({ name: "I1 Label A", changes: { cost_price: { from: 100, to: 101 } } });
    expect(rows[1]).toMatchObject({ name: "I3 NoList A", changes: { cost_price: { from: 80, to: 81 } } });
    expect(rows[3].error).toBe("New item needs a name");
    expect(rows[4].error).toBe("Needs an item code or name");
    expect(r.body.summary).toEqual({ new: 1, update: 2, unchanged: 0, error: 2 });
  });
  test("duplicate rows in the same sheet -> error row", async () => {
    const r = await preview(A.users.pricer, [{ item_code: "I1-A", cost_price: 1 }, { item_code: "i1-a", cost_price: 2 }, { name: "x new" }, { name: "X NEW" }]);
    expect(r.body.rows.map((x) => x.status)).toEqual(["update", "error", "new", "error"]);
    expect(r.body.rows[1].error).toBe("Same item appears earlier in the sheet");
  });
  test("[FIXED in G0] same item once by code and once by name IS caught as a duplicate (was: both rows updated it)", async () => {
    const r = await preview(A.users.pricer, [{ item_code: "I1-A", cost_price: 111 }, { name: "I1 Label A", cost_price: 222 }]);
    expect(r.body.rows.map((x) => x.status)).toEqual(["update", "error"]);
    expect(r.body.rows[1].error).toBe("Same item appears earlier in the sheet");
  });
  test("[RECORD] unknown code + existing name -> matched by name and its item_code is OVERWRITTEN", async () => {
    const r = await preview(A.users.pricer, [{ item_code: "OTHER-CODE", name: "I5 Brady A" }]);
    expect(r.body.rows[0]).toMatchObject({ status: "update", changes: { item_code: { from: "BR-001", to: "OTHER-CODE" } } });
  });
  test("preview writes nothing", async () => {
    const before = await Item().find({ tenant_id: A.tenantId }).lean();
    await preview(A.users.pricer, [{ item_code: "I1-A", cost_price: 5 }, { name: "Never Created", cost_price: 1 }]);
    expect(await Item().find({ tenant_id: A.tenantId }).lean()).toEqual(before);
  });
});

describe("5.2 POSITIVE", () => {
  test("list + search (name, code, HSN) + paging, sorted by name, own company only", async () => {
    const v = A.users.viewer.api;
    const all = await v.get(`${P}/items?limit=500`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(6);
    expect(all.body.data.every((i) => i.name.endsWith(" A"))).toBe(true);
    // CRM Items ("CRM Only Widget", "I1") are never part of the PO item list (G0)
    expect(all.body.data.map((i) => i.name)).not.toContain("CRM Only Widget");
    expect(all.body.data.map((i) => i.name)).not.toContain("I1");
    expect(all.body.data.map((i) => i.name)).toEqual([...all.body.data.map((i) => i.name)].sort());
    expect((await v.get(`${P}/items?search=twotax`)).body.total).toBe(1);
    expect((await v.get(`${P}/items?search=br-001`)).body.total).toBe(1);
    expect((await v.get(`${P}/items?search=4821`)).body.total).toBe(1);
    expect((await v.get(`${P}/items?search=(`)).status).toBe(200);
    const p2 = await v.get(`${P}/items?limit=4&page=2`);
    expect(p2.body).toMatchObject({ total: 6, pages: 2, page: 2 });
    expect(p2.body.data).toHaveLength(2);
    const i6 = (await v.get(`${P}/items?search=I6`)).body.data[0];
    expect(i6.tax_rate).toBe(23); // PoItem keeps one GST % (was tax + tax2 on the CRM Item)
  });

  test("[QUESTION] any PO viewer (View(Global) or View(Own)) can read cost / landing prices", async () => {
    const r = await A.users.own.api.get(`${P}/items?search=I1`);
    expect(r.status).toBe(200);
    expect(r.body.data[0].cost_price).toBe(100);
  });

  test("edit one item's prices -> saved + Activity Log row (finding 5e)", async () => {
    const it = await Item().create({ name: "Edit Me", tenant_id: A.tenantId, cost_price: 10, end_customer_price: 20 });
    const r = await A.users.pricer.api.put(`${P}/items/${it._id}`, { cost_price: "12.5", end_customer_price: 25, item_code: " EM-1 ", master_price: "" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cost_price: 12.5, end_customer_price: 25, item_code: "EM-1", master_price: 0 });
    const log = await waitFor(() => ActivityLog().findOne({ rel_id: it._id }).lean());
    // G0: PO item log (rel_type "po_item", "PO items:" prefix); text fields are listed before prices.
    expect(log).toMatchObject({ rel_type: "po_item", description: 'PO items: "Edit Me" item code - → EM-1, cost price 10 → 12.5, end customer price 20 → 25' });
    expect(String(log.tenant_id)).toBe(String(A.tenantId));
  });

  test("no change -> no Activity Log row", async () => {
    const it = await Item().create({ name: "Same", tenant_id: A.tenantId, cost_price: 10 });
    await A.users.pricer.api.put(`${P}/items/${it._id}`, { cost_price: 10 });
    await new Promise((r) => setTimeout(r, 200));
    expect(await ActivityLog().countDocuments({ rel_id: it._id })).toBe(0);
  });

  test("sheet with new / update / unchanged rows: preview counts -> import -> list updated -> activity log (finding 5c, 5e)", async () => {
    await Item().create({ name: "Sheet Upd", item_code: "SU-1", tenant_id: A.tenantId, cost_price: 1, end_customer_price: 2 });
    await Item().create({ name: "Sheet Same", item_code: "SS-1", tenant_id: A.tenantId, cost_price: 3 });
    const rows = [
      { item_code: "SU-1", cost_price: 1.5, distributor_price: "1,999" },
      { item_code: "SS-1", cost_price: 3 },
      { name: "Sheet New", item_code: "SN-1", hsn: " 3919 ", cost_price: 7, end_customer_price: 11 },
      { name: "Sheet New2" },
    ];
    const pv = await preview(A.users.pricer, rows);
    expect(pv.body.summary).toEqual({ new: 2, update: 1, unchanged: 1, error: 0 });
    const im = await importRows(A.users.pricer, rows);
    expect(im.status).toBe(200);
    expect(im.body).toMatchObject({ updated: 1, created: 2, skipped: 0, message: "PO items saved: 1 updated, 2 added." });
    const upd = await Item().findOne({ tenant_id: A.tenantId, item_code: "SU-1" }).lean();
    expect(upd).toMatchObject({ cost_price: 1.5, distributor_price: 1999, end_customer_price: 2 });
    const neu = await Item().findOne({ tenant_id: A.tenantId, item_code: "SN-1" }).lean();
    // PoItem has hsn (no hsn_sac_code) and no CRM "rate" field
    expect(neu).toMatchObject({ name: "Sheet New", unit: "Nos", hsn: "3919", cost_price: 7, end_customer_price: 11, active: true });
    const neu2 = await Item().findOne({ tenant_id: A.tenantId, name: "Sheet New2" }).lean();
    expect(neu2).toMatchObject({ unit: "Nos", end_customer_price: 0 });
    expect(neu2.item_code).toBeUndefined();
    const logs = await waitFor(async () => { const x = await ActivityLog().find({ tenant_id: A.tenantId, description: /Sheet/ }).lean(); return x.length >= 3 ? x : null; });
    expect(logs.map((l) => l.description).sort()).toEqual([
      'PO items: "Sheet Upd" cost price 1 → 1.5, distributor price 0 → 1999',
      'PO items: added "Sheet New" (item code - → SN-1, hsn - → 3919, cost price - → 7, end customer price - → 11)',
      'PO items: added "Sheet New2" ()',
    ].sort());
    expect((await A.users.viewer.api.get(`${P}/items?search=Sheet New`)).body.total).toBe(2);
  });

  test("import with an error row: other rows saved, message says rows skipped", async () => {
    const r = await importRows(A.users.pricer, [{ name: "Err Row", cost_price: -1 }, { name: "Good Row", cost_price: 1 }]);
    expect(r.body).toMatchObject({ created: 1, skipped: 1 });
    expect(r.body.message).toMatch(/rows with errors skipped/);
  });
});

describe("5.3 NEGATIVE", () => {
  test("negative / text price on PUT /items/:itemId", async () => {
    const id = A.items.I3._id;
    expect((await A.users.pricer.api.put(`${P}/items/${id}`, { cost_price: -1 })).status).toBe(400);
    expect((await A.users.pricer.api.put(`${P}/items/${id}`, { cost_price: "1.2.3" })).status).toBe(400);
  });
  test("[FIXED] PUT /items/:itemId cost_price '1e5' / '12abc' / 'abc' -> 400, price unchanged", async () => {
    const it = await Item().create({ name: "Exp", tenant_id: A.tenantId, cost_price: 10 });
    for (const v of ["1e5", "12abc", "abc"]) {
      const r = await A.users.pricer.api.put(`${P}/items/${it._id}`, { cost_price: v });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("cost price is not a valid amount");
    }
    expect((await Item().findById(it._id).lean()).cost_price).toBe(10);
  });
  test("PUT /items/:itemId with '₹ 1,250.50' / 'Rs 99' still saves (positive after the fix)", async () => {
    const it = await Item().create({ name: "Exp2", tenant_id: A.tenantId, cost_price: 10 });
    const r = await A.users.pricer.api.put(`${P}/items/${it._id}`, { cost_price: "₹ 1,250.50", end_customer_price: "Rs 99" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cost_price: 1250.5, end_customer_price: 99 });
  });
  test("empty sheet / rows not an array / missing -> 400", async () => {
    for (const rows of [[], "abc", { a: 1 }, undefined, null, 5]) {
      expect((await preview(A.users.pricer, rows)).status).toBe(400);
      expect((await importRows(A.users.pricer, rows)).status).toBe(400);
    }
  });
  test("[FIXED] a null row in the sheet -> error row 'Empty row' (was 500); import saves the good rows", async () => {
    const r = await preview(A.users.pricer, [null]);
    expect(r.status).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ row: 2, status: "error", error: "Empty row" });
    const im = await importRows(A.users.pricer, [{ name: "ok null-row test" }, null]);
    expect(im.status).toBe(200);
    expect(im.body).toMatchObject({ created: 1, skipped: 1 });
  });
  test("rows 5 / 'x' (non-objects) -> 'Empty row' error rows, 200", async () => {
    const r = await preview(A.users.pricer, [5, "x"]);
    expect(r.status).toBe(200);
    expect(r.body.summary.error).toBe(2);
    expect(r.body.rows.map((x) => x.error)).toEqual(["Empty row", "Empty row"]);
  });
  test("import with a '1e5' cell: that row is skipped, the item keeps its price", async () => {
    const r = await importRows(A.users.pricer, [{ item_code: "I3-A", cost_price: "1e5" }]);
    expect(r.body).toMatchObject({ updated: 0, skipped: 1 });
    expect((await Item().findById(A.items.I3._id).lean()).cost_price).toBe(80);
  });
  test("[CHANGED in G0] 10,000-char name -> error row (PoItem name max 300); HTML name stored as plain text", async () => {
    const long = "L".repeat(10000);
    const html = "<img src=x onerror=\"window.__xss=(window.__xss||0)+1\">";
    const r = await importRows(A.users.pricer, [{ name: long, cost_price: 1 }, { name: html, cost_price: 1 }]);
    expect(r.body).toMatchObject({ created: 1, skipped: 1 });
    expect((await preview(A.users.pricer, [{ name: long }])).body.rows[0].error).toBe("Name can't be longer than 300 characters");
    expect(await Item().countDocuments({ tenant_id: A.tenantId, name: html })).toBe(1);
  });
  test("[FIXED in G0] duplicate-name lock: two parallel imports of the same new name create ONE item (was 2)", async () => {
    const rows = [{ name: "Race Item", cost_price: 1 }];
    const [r1, r2] = await Promise.all([importRows(A.users.pricer, rows), importRows(A.users.pricer, rows)]);
    expect(r1.body.created + r2.body.created).toBe(1);
    expect(await Item().countDocuments({ tenant_id: A.tenantId, name: "Race Item" })).toBe(1);
  });
  test("code of another company's item creates a NEW item in A; B's item untouched", async () => {
    const bBefore = await Item().findById(B.items.I5._id).lean();
    const r = await importRows(A.users.pricer, [{ item_code: "BR-001-B", name: "Copy of B", cost_price: 1 }]);
    expect(r.body).toMatchObject({ created: 1, updated: 0 });
    expect(await Item().findById(B.items.I5._id).lean()).toEqual(bBefore);
    expect(await Item().countDocuments({ tenant_id: A.tenantId, item_code: "BR-001-B" })).toBe(1);
  });
  test("Manage Prices missing -> 403 on preview / import / edit / create / delete", async () => {
    for (const u of ["maker", "viewer", "approver", "full", "own"]) {
      expect((await A.users[u].api.post(`${P}/items`, { name: "No perm" })).status).toBe(403);
      expect((await A.users[u].api.del(`${P}/items/${A.items.I2._id}`)).status).toBe(403);
      expect((await preview(A.users[u], [{ item_code: "I1-A", cost_price: 1 }])).status).toBe(403);
      expect((await importRows(A.users[u], [{ item_code: "I1-A", cost_price: 1 }])).status).toBe(403);
      expect((await A.users[u].api.put(`${P}/items/${A.items.I1._id}`, { cost_price: 1 })).status).toBe(403);
    }
    expect((await Item().findById(A.items.I1._id).lean()).cost_price).toBe(100);
  });
  test("item of Tenant B -> 404 on PUT; invalid id -> 404; B unchanged", async () => {
    expect((await A.users.pricer.api.put(`${P}/items/${B.items.I1._id}`, { cost_price: 1 })).status).toBe(404);
    expect((await A.users.pricer.api.put(`${P}/items/bad`, { cost_price: 1 })).status).toBe(404);
    expect((await Item().findById(B.items.I1._id).lean()).cost_price).toBe(100);
  });
  test("[RECORD] 5d: 20,000-row import has no row limit", async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => ({ name: `Bulk ${i}`, item_code: `BULK-${i}`, cost_price: i % 100, end_customer_price: (i % 100) + 1 }));
    const t = Date.now();
    const r = await importRows(A.users.pricer, rows);
    console.log("[record] 20000-row import ->", r.status, JSON.stringify(r.body), `${Date.now() - t}ms`);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(20000);
    expect(await Item().countDocuments({ tenant_id: A.tenantId, item_code: /^BULK-/ })).toBe(20000);
  });
});

describe("5.5 INTEGRATION", () => {
  test("sheet price change: NEW PO uses new prices; OLD draft re-priced only on submit; approved PO never changes", async () => {
    const it = await Item().create({ name: "Flow Item", item_code: "FL-1", tenant_id: A.tenantId, cost_price: 100, end_customer_price: 160 });
    const draft = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(it, 1)] })).body;
    // R4: approved = admin submits, then presses Yes.
    const appr = await S.approvedPo(A, [S.line(it, 1)], {}, { maker: "admin", approver: "admin" });
    expect(appr.status).toBe("approved");
    await importRows(A.users.pricer, [{ item_code: "FL-1", cost_price: 120, end_customer_price: 200 }]);
    const fresh = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(it, 1)] })).body;
    expect(fresh.items[0]).toMatchObject({ cost_price: 120, list_price: 200 });
    expect((await PurchaseOrder().findById(draft._id).lean()).items[0]).toMatchObject({ cost_price: 100, list_price: 160 });
    // R6: on submit the old selling price (160) is now below the new End User
    // Price (200) -> refused; the maker updates the price and submits again.
    const refused = await A.users.maker.api.post(`${P}/${draft._id}/submit`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/can't be lower than the price-master price 200/);
    await A.users.maker.api.put(`${P}/${draft._id}`, { items: [S.line(it, 1, { selling_price: 200 })] });
    const sub = (await A.users.maker.api.post(`${P}/${draft._id}/submit`, {})).body;
    expect(sub.items[0]).toMatchObject({ cost_price: 120, list_price: 200 });
    expect((await PurchaseOrder().findById(appr._id).lean()).items[0]).toMatchObject({ cost_price: 100, list_price: 160 });
  });

  test("[CHANGED in G0] items created by the sheet do NOT show in the Items module (GET /api/items); CRM Item count unchanged", async () => {
    const before = await CrmItem().countDocuments({ tenant_id: A.tenantId });
    await importRows(A.users.pricer, [{ name: "From Sheet For Items", item_code: "FSI-1", cost_price: 3, end_customer_price: 5 }]);
    const r = await A.users.admin.api.get("/api/items?search=From Sheet For Items");
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(0);
    expect(await CrmItem().countDocuments({ tenant_id: A.tenantId })).toBe(before);
    expect(await Item().countDocuments({ tenant_id: A.tenantId, name: "From Sheet For Items" })).toBe(1);
  });

  test("PUT /api/items/:id with master_price / cost_price / item_code / distributor / end_customer is IGNORED (finding 5f)", async () => {
    const it = await CrmItem().create({ name: "Items Form", item_code: "IF-1", tenant_id: A.tenantId, master_price: 1, cost_price: 2, distributor_price: 3, end_customer_price: 4 });
    const r = await A.users.admin.api.put(`/api/items/${it._id}`, { name: "Items Form", rate: 9, master_price: 100, cost_price: 200, distributor_price: 300, end_customer_price: 400, item_code: "HACK" });
    expect(r.status).toBe(200);
    expect(await CrmItem().findById(it._id).lean()).toMatchObject({ rate: 9, master_price: 1, cost_price: 2, distributor_price: 3, end_customer_price: 4, item_code: "IF-1" });
    const c = await A.users.admin.api.post("/api/items", { name: "Items Form New", cost_price: 50, master_price: 60, item_code: "X" });
    expect(c.status).toBe(201);
    expect(await CrmItem().findById(c.body._id).lean()).toMatchObject({ cost_price: 0, master_price: 0 });
    expect((await CrmItem().findById(c.body._id).lean()).item_code).toBeUndefined();
  });

  test("[RECORD] POST /api/items/import with price columns — price fields stripped?", async () => {
    const r = await A.users.admin.api.post("/api/items/import", [{ "Item Name": "Imp Via Items", cost_price: 77, master_price: 88 }]);
    const it = await CrmItem().findOne({ tenant_id: A.tenantId, name: "Imp Via Items" }).lean();
    console.log("[record] /api/items/import ->", r.status, it && { cost_price: it.cost_price, master_price: it.master_price });
    if (it) expect(it.cost_price).toBe(0);
  });
});
