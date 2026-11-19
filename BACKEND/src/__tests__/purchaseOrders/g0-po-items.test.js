// G0 — PO Items: the PO module's own item list (PoItem), separate from the CRM
// Items module. /api/purchase-orders/items (list, create, edit, delete,
// import preview / import, export) + the editor picker + buildLines on PoItem.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
let A, B, C, D;
const PoItem = () => require("../../models/PoItem");
const Item = () => require("../../models/Item");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ctrl = () => require("../../controllers/purchase_order_controller");

const preview = (u, rows) => u.api.post(`${P}/items/import/preview`, { rows });
const importRows = (u, rows) => u.api.post(`${P}/items/import`, { rows });
const addItem = (u, body) => u.api.post(`${P}/items`, body);
// Round 28 (R1/R6): the customer + selling price are on the Purchase PO now
// (Sales PO was removed); the helper keeps its name.
const sales = (items, extra = {}) => ({ type: "purchase", division: "brady", customer: String(A.customers.c1._id), items, ...extra });

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] }); // add-on off
  D = await S.seedTenant("D"); // add-on ticked, NOT in the env list
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] G0", JSON.stringify(S.guardReport()));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("G0 UNIT — PoItem model + cleaning", () => {
  const errs = (doc) => Object.keys(doc.validateSync()?.errors || {});
  const tenant_id = "64b000000000000000000001";

  test("name required, max 300; defaults unit Nos, active true, prices 0", () => {
    expect(errs(new (PoItem())({ tenant_id }))).toContain("name");
    expect(errs(new (PoItem())({ tenant_id, name: "N".repeat(301) }))).toContain("name");
    const ok = new (PoItem())({ tenant_id, name: "N".repeat(300) });
    expect(errs(ok)).toEqual([]);
    expect(ok).toMatchObject({ unit: "Nos", active: true, tax_rate: 0, master_price: 0, cost_price: 0, distributor_price: 0, end_customer_price: 0 });
  });
  test("tenant_id required; GST 0-100; prices >= 0", () => {
    expect(errs(new (PoItem())({ name: "x" }))).toContain("tenant_id");
    expect(errs(new (PoItem())({ tenant_id, name: "x", tax_rate: 101 }))).toContain("tax_rate");
    expect(errs(new (PoItem())({ tenant_id, name: "x", tax_rate: -1 }))).toContain("tax_rate");
    expect(errs(new (PoItem())({ tenant_id, name: "x", tax_rate: 100 }))).toEqual([]);
    for (const f of ["master_price", "cost_price", "distributor_price", "end_customer_price"]) {
      expect(errs(new (PoItem())({ tenant_id, name: "x", [f]: -1 }))).toContain(f);
    }
  });
  test("tenant_id is indexed (non-unique); no unique index on name / item_code", () => {
    const idx = PoItem().schema.indexes();
    expect(idx).toEqual([[{ tenant_id: 1 }, { background: true }]]);
    expect(idx.some(([, o]) => o.unique)).toBe(false);
  });
  test.each([
    ["1,250", 1250], ["₹ 1,250.50", 1250.5], ["Rs. 99", 99], [12.345, 12.35], ["0", 0],
  ])("priceNum(%p) = %p", (v, out) => expect(ctrl().priceNum(v)).toBe(out));
  test.each([["1e5"], ["12abc"], ["abc"], [-5], ["-5"], [NaN], [Infinity]])("priceNum(%p) -> NaN (error)", (v) => {
    expect(Number.isNaN(ctrl().priceNum(v))).toBe(true);
  });
  test("priceNum blank -> undefined (keep old)", () => {
    for (const v of [undefined, null, "", "  "]) expect(ctrl().priceNum(v)).toBeUndefined();
  });
  test.each([[18, 18], ["18", 18], ["18%", 18], [" 5 % ", 5], [0, 0], [100, 100], ["12.5", 12.5]])("gstNum(%p) = %p", (v, out) => {
    expect(ctrl().gstNum(v)).toBe(out);
  });
  test.each([[101], ["101"], [-1], ["abc"], ["1e1"], ["18abc"]])("gstNum(%p) -> NaN", (v) => expect(Number.isNaN(ctrl().gstNum(v))).toBe(true));
  test("cleanPoItem: trims text, unit '' -> Nos, rejects bad values with clear messages", () => {
    const { cleanPoItem } = ctrl();
    expect(cleanPoItem({ name: "  A  ", item_code: " C1 ", unit: "", tax_rate: "18%", cost_price: "1,250" }, { isNew: true }))
      .toEqual({ name: "A", item_code: "C1", unit: "Nos", tax_rate: 18, cost_price: 1250 });
    const err = (src, isNew = true) => { try { cleanPoItem(src, { isNew }); return null; } catch (e) { return [e.status, e.message]; } };
    // Round 29 (S4): the name is optional on a new item (it becomes the
    // catalog no. — catalog / series / End User Price are checked by the
    // create endpoint); an edit still can't blank it.
    expect(err({})).toBeNull();
    expect(err({ name: "   " })).toBeNull();
    expect(err({ name: "" }, false)).toEqual([400, "Name can't be empty"]);
    expect(err({ name: "N".repeat(301) })).toEqual([400, "Name can't be longer than 300 characters"]);
    expect(err({ name: "x", tax_rate: 101 })).toEqual([400, "GST % must be a number from 0 to 100"]);
    expect(err({ name: "x", cost_price: -1 })).toEqual([400, "cost price is not a valid amount"]);
    expect(err({ name: "x", master_price: "abc" })).toEqual([400, "master price is not a valid amount"]);
    expect(err({ name: { $gt: "" } })).toEqual([400, "Name: enter text"]);
    expect(err({ name: "x", active: "no" })).toEqual([400, "Active must be true or false"]);
    expect(err({ name: "x" }, false)).toBeNull();
  });
});

describe("G0 POSITIVE", () => {
  test("add an item (Manage Prices) -> 201 with every field; Activity Log row", async () => {
    const r = await addItem(A.users.pricer, { item_code: "NEW-1", name: "New Tape", description: "24mm", hsn: "3919", unit: "Roll", tax_rate: 12, master_price: 90, cost_price: 50, distributor_price: 70, end_customer_price: 100, category: "Tapes" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ item_code: "NEW-1", name: "New Tape", description: "24mm", hsn: "3919", unit: "Roll", tax_rate: 12, master_price: 90, cost_price: 50, distributor_price: 70, end_customer_price: 100, category: "Tapes", active: true });
    expect(String(r.body.tenant_id)).toBe(String(A.tenantId));
    expect(String(r.body.created_by)).toBe(String(A.users.pricer.id));
    const log = await waitFor(() => require("../../models/ActivityLog").findOne({ rel_id: r.body._id }).lean());
    expect(log).toMatchObject({ rel_type: "po_item" });
    expect(log.description).toMatch(/^PO items: added "New Tape"/);
  });
  // Round 29 (S4): catalog no., series and End User Price are required now —
  // a blank catalog is refused; the minimal item has just those three.
  test("admin can add too; minimal item (catalog + series + End User Price) gets unit Nos, 0 other prices, name = catalog; blank catalog -> 400", async () => {
    const r = await addItem(A.users.admin, { item_code: "MIN-1", category: "Minimal", end_customer_price: 1 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "MIN-1", item_code: "MIN-1", category: "Minimal", unit: "Nos", tax_rate: 0, cost_price: 0, end_customer_price: 1 });
    const blank = await addItem(A.users.admin, { name: "Minimal Item", item_code: "  ", category: "Minimal", end_customer_price: 1 });
    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ message: "Catalog no. is required", field: "item_code" });
  });
  test("edit any field; blank price keeps the old value; clearing the code removes it", async () => {
    const it = (await addItem(A.users.pricer, { name: "Editable", item_code: "ED-1", cost_price: 10, end_customer_price: 20, category: "Edit" })).body;
    const r = await A.users.pricer.api.put(`${P}/items/${it._id}`, { name: "Editable 2", hsn: "1234", tax_rate: "5", cost_price: "", end_customer_price: "25" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Editable 2", hsn: "1234", tax_rate: 5, cost_price: 10, end_customer_price: 25, item_code: "ED-1" });
    // Round 29 (S4): the catalog no. is required — it can't be cleared any more.
    const r2 = await A.users.pricer.api.put(`${P}/items/${it._id}`, { item_code: "" });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toBe("Catalog no. is required");
    // renaming to its own name in another case is fine
    expect((await A.users.pricer.api.put(`${P}/items/${it._id}`, { name: "EDITABLE 2" })).status).toBe(200);
  });
  test("switch off: hidden from the picker (?active=true), listed with ?active=false; a PO that has it still opens and can be edited", async () => {
    const it = (await addItem(A.users.pricer, { name: "Switch Me", item_code: "SW-1", category: "Switch", cost_price: 10, end_customer_price: 20 })).body;
    const po = (await A.users.maker.api.post(P, sales([S.line(it, 1)]))).body;
    const off = await A.users.pricer.api.put(`${P}/items/${it._id}`, { active: false });
    expect(off.body.active).toBe(false);
    const picker = (await A.users.maker.api.get(`${P}/items?active=true&limit=500`)).body.data.map((i) => i.name);
    expect(picker).not.toContain("Switch Me");
    expect((await A.users.maker.api.get(`${P}/items?active=false&limit=500`)).body.data.map((i) => i.name)).toEqual(["Switch Me"]);
    expect((await A.users.maker.api.get(`${P}/items?active=all&search=Switch Me`)).body.total).toBe(1);
    const g = await A.users.maker.api.get(`${P}/${po._id}`);
    expect(g.status).toBe(200);
    expect(g.body.items[0].name).toBe("Switch Me");
    const e = await A.users.maker.api.put(`${P}/${po._id}`, sales([S.line(it, 3)]));
    expect(e.status).toBe(200);
    expect(e.body.items[0].qty).toBe(3);
    // ...but it can't be put on a new PO
    const n = await A.users.maker.api.post(P, sales([S.line(it, 1)]));
    expect(n.status).toBe(400);
    expect(n.body.message).toBe("Line 1: Switch Me is switched off in PO Items");
    // switch on again -> usable
    await A.users.pricer.api.put(`${P}/items/${it._id}`, { active: true });
    expect((await A.users.maker.api.post(P, sales([S.line(it, 1)]))).status).toBe(201);
  });
  test("delete an unused item -> gone; Activity Log row", async () => {
    const it = (await addItem(A.users.pricer, { name: "Delete Me", item_code: "DEL-1", category: "Delete", end_customer_price: 1 })).body;
    const r = await A.users.pricer.api.del(`${P}/items/${it._id}`);
    expect(r.status).toBe(200);
    expect(await PoItem().findById(it._id)).toBeNull();
    const log = await waitFor(() => require("../../models/ActivityLog").findOne({ rel_id: it._id, description: /deleted/ }).lean());
    expect(log.description).toBe('PO items: deleted "Delete Me"');
  });
  test("Excel upload: new + update + unchanged rows, preview counts, import, values saved", async () => {
    await addItem(A.users.pricer, { name: "Xl Upd", item_code: "XU-1", cost_price: 1, end_customer_price: 2, tax_rate: 5, category: "Xl" });
    await addItem(A.users.pricer, { name: "Xl Same", item_code: "XS-1", cost_price: 3, end_customer_price: 4, category: "Xl" });
    const rows = [
      { item_code: "XU-1", cost_price: "1.5", tax_rate: "18%", unit: "Box" },
      { item_code: "XS-1", cost_price: 3 },
      { item_code: "XN-1", name: "Xl New", hsn: 3919, unit: "", tax_rate: 12, master_price: "₹ 1,000", cost_price: 700, distributor_price: 800, end_customer_price: "1,200" },
    ];
    const pv = await preview(A.users.pricer, rows);
    expect(pv.status).toBe(200);
    expect(pv.body.summary).toEqual({ new: 1, update: 1, unchanged: 1, error: 0 });
    expect(pv.body.rows[0].changes).toEqual({ unit: { from: "Nos", to: "Box" }, tax_rate: { from: 5, to: 18 }, cost_price: { from: 1, to: 1.5 } });
    const im = await importRows(A.users.pricer, rows);
    expect(im.body).toMatchObject({ updated: 1, created: 1, skipped: 0, message: "PO items saved: 1 updated, 1 added." });
    expect(await PoItem().findOne({ tenant_id: A.tenantId, item_code: "XU-1" }).lean()).toMatchObject({ cost_price: 1.5, tax_rate: 18, unit: "Box", end_customer_price: 2 });
    expect(await PoItem().findOne({ tenant_id: A.tenantId, item_code: "XN-1" }).lean()).toMatchObject({ name: "Xl New", hsn: "3919", unit: "Nos", tax_rate: 12, master_price: 1000, cost_price: 700, distributor_price: 800, end_customer_price: 1200, active: true });
  });
  test("export: every item of the company with the upload columns + active, sorted by name", async () => {
    const r = await A.users.viewer.api.get(`${P}/items/export`);
    expect(r.status).toBe(200);
    const names = r.body.rows.map((x) => x.name);
    expect(names).toEqual([...names].sort());
    expect(names).not.toContain("CRM Only Widget");
    expect(r.body.rows.every((x) => !x.name.endsWith(" B"))).toBe(true);
    const i1 = r.body.rows.find((x) => x.item_code === "I1-A");
    expect(i1).toEqual({ item_code: "I1-A", y_code: "", name: "I1 Label A", description: "", hsn: "4821", unit: "Nos", tax_rate: 18, master_price: 150, cost_price: 100, distributor_price: 140, end_customer_price: 160, lead_time: "", remarks: "", category: "", active: true });
    expect(r.body.rows.find((x) => x.name === "Switch Me")).toBeDefined();
  });
  test("picker list (active=true) shows only PO items; picking I1 copies code, name, HSN, unit, GST and prices onto the line", async () => {
    const pick = (await A.users.maker.api.get(`${P}/items?active=true&search=I1`)).body.data;
    expect(pick.map((i) => i.name)).toEqual(["I1 Label A"]); // CRM Item "I1" is not there
    const it = pick[0];
    const r = await A.users.maker.api.post(P, sales([{ item_id: it._id, qty: 2 }]));
    expect(r.status).toBe(201);
    expect(r.body.items[0]).toMatchObject({ item_code: "I1-A", name: "I1 Label A", hsn: "4821", unit: "Nos", tax_rate: 18, cost_price: 150, cost_source: "mdp", list_price: 160, selling_price: 160 });
    expect(String(r.body.items[0].item_id)).toBe(String(A.items.I1._id));
  });
  test("list: search by code / name / HSN, paging, sorted by name", async () => {
    const v = A.users.viewer.api;
    expect((await v.get(`${P}/items?search=4821`)).body.data[0].name).toBe("I1 Label A");
    expect((await v.get(`${P}/items?search=br-001`)).body.total).toBe(1);
    const p1 = await v.get(`${P}/items?limit=2&page=1`);
    expect(p1.body).toMatchObject({ page: 1, limit: 2 });
    expect(p1.body.data).toHaveLength(2);
  });
});

describe("G0 NEGATIVE", () => {
  test("duplicate item code / name in the same company -> 400 (case-insensitive); same name in another company OK", async () => {
    // Round 29 (S4): a duplicate is 409 "already exists — edit it instead".
    const ok = { category: "Dup", end_customer_price: 1 };
    const d1 = await addItem(A.users.pricer, { name: "i1 label a", item_code: "OTHER-9", ...ok });
    expect(d1.status).toBe(409);
    expect(d1.body.message).toBe('A PO item named "I1 Label A" already exists — edit it instead');
    const d2 = await addItem(A.users.pricer, { name: "Other", item_code: "i1-a", ...ok });
    expect(d2.status).toBe(409);
    expect(d2.body.message).toBe('Catalog no. "I1-A" already exists — edit it instead');
    expect((await addItem(B.users.pricer, { name: "I1 Label A", item_code: "I1-A", ...ok })).status).toBe(201);
  });
  test("edit into another item's name / code -> 400, item unchanged", async () => {
    const it = (await addItem(A.users.pricer, { name: "Rename Me", item_code: "RN-1", category: "Rename", end_customer_price: 1 })).body;
    // Round 29 (S4): duplicates are 409 now.
    expect((await A.users.pricer.api.put(`${P}/items/${it._id}`, { name: "I2 NoCost A" })).status).toBe(409);
    expect((await A.users.pricer.api.put(`${P}/items/${it._id}`, { item_code: "BR-001" })).status).toBe(409);
    expect(await PoItem().findById(it._id).lean()).toMatchObject({ name: "Rename Me", item_code: "RN-1" });
  });
  test("two parallel creates of the same name -> one 201, one 409 (lock)", async () => {
    const t = { category: "Twin", end_customer_price: 1 };
    const [a, b] = await Promise.all([addItem(A.users.pricer, { name: "Twin", item_code: "TW-1", ...t }), addItem(A.users.pricer, { name: "TWIN", item_code: "TW-2", ...t })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, name: /^twin$/i })).toBe(1);
  });
  // Round 29 (S4): every body carries the now-required catalog / series /
  // End User Price (G_OK) unless the row tests exactly that field; the old
  // "Name is required" rows became the catalog / series / EP rows.
  const G_OK = { item_code: "G-1", category: "G", end_customer_price: 1 };
  test.each([
    [{ name: "G", tax_rate: 101 }, "GST % must be a number from 0 to 100"],
    [{ name: "G", tax_rate: "abc" }, "GST % must be a number from 0 to 100"],
    [{ name: "G", cost_price: -1 }, "cost price is not a valid amount"],
    [{ name: "G", end_customer_price: "abc" }, "end customer price is not a valid amount"],
    [{ name: "G", master_price: "1e5" }, "master price is not a valid amount"],
    [{ name: "G", item_code: "" }, "Catalog no. is required"],
    [{ name: "G", category: "" }, "Series is required"],
    [{ name: "G", end_customer_price: 0 }, "End User Price is required"],
    [{ name: "N".repeat(301) }, "Name can't be longer than 300 characters"],
    [{ name: "G", item_code: "C".repeat(101) }, "Item code can't be longer than 100 characters"],
  ])("create %j -> 400 %s", async (body, msg) => {
    const before = await PoItem().countDocuments({ tenant_id: A.tenantId });
    const r = await addItem(A.users.pricer, { ...G_OK, ...body });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(msg);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("edit with GST 101 / price -1 / empty name -> 400, item unchanged", async () => {
    const id = A.items.I3._id;
    for (const body of [{ tax_rate: 101 }, { cost_price: -1 }, { name: "" }, { name: "  " }]) {
      expect((await A.users.pricer.api.put(`${P}/items/${id}`, body)).status).toBe(400);
    }
    expect(await PoItem().findById(id).lean()).toMatchObject({ name: "I3 NoList A", cost_price: 80, tax_rate: 0 });
  });
  test("delete an item used on a PO -> 400 'switch it off instead'; item kept", async () => {
    const r = await A.users.pricer.api.del(`${P}/items/${A.items.I1._id}`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("This item is used on a PO — switch it off instead");
    expect(await PoItem().findById(A.items.I1._id)).not.toBeNull();
  });
  test("import with bad rows -> error rows, nothing changed for them; good rows saved", async () => {
    const before = await PoItem().findById(A.items.I5._id).lean();
    const rows = [
      { item_code: "BR-001", cost_price: "12abc" },
      { item_code: "BR-001", tax_rate: 150 },
      { name: "Bad New", cost_price: -5 },
      { name: "N".repeat(301) },
      { item_code: "", name: "" },
      { item_code: "I5-unknown" },
      { name: "Good New Row", cost_price: 1 },
    ];
    const pv = await preview(A.users.pricer, rows);
    expect(pv.body.rows.map((r) => r.status)).toEqual(["error", "error", "error", "error", "error", "error", "new"]);
    expect(pv.body.rows.map((r) => r.error)).toEqual([
      "cost price is not a valid amount",
      "GST % must be a number from 0 to 100",
      "cost price is not a valid amount",
      "Name can't be longer than 300 characters",
      "Needs an item code or name",
      "New item needs a name",
      undefined,
    ]);
    const im = await importRows(A.users.pricer, rows);
    expect(im.body).toMatchObject({ created: 1, updated: 0, skipped: 6 });
    expect(await PoItem().findById(A.items.I5._id).lean()).toEqual(before);
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, name: "Bad New" })).toBe(0);
  });
  test("import: renaming one item (matched by code) into another item's name -> error row", async () => {
    const r = await preview(A.users.pricer, [{ item_code: "BR-001", name: "I2 NoCost A" }]);
    expect(r.body.rows[0]).toMatchObject({ status: "error", error: 'Another PO item is already named "I2 NoCost A"' });
  });
  test("import: a new row's code claimed by a later row for another item -> error row", async () => {
    const r = await preview(A.users.pricer, [{ name: "Claim New", item_code: "CL-9" }, { name: "I2 NoCost A", item_code: "cl-9" }]);
    expect(r.body.rows.map((x) => x.status)).toEqual(["new", "error"]);
  });
  test("no Manage Prices -> 403 on create / edit / delete / preview / import; nothing changed", async () => {
    const before = await PoItem().find({ tenant_id: A.tenantId }).sort({ _id: 1 }).lean();
    for (const u of ["maker", "full", "approver", "viewer", "own", "ownApprover", "roleApprover"]) {
      const api = A.users[u].api;
      expect((await api.post(`${P}/items`, { name: "Nope" })).status).toBe(403);
      expect((await api.put(`${P}/items/${A.items.I2._id}`, { cost_price: 1 })).status).toBe(403);
      expect((await api.del(`${P}/items/${A.items.I2._id}`)).status).toBe(403);
      expect((await preview(A.users[u], [{ name: "Nope" }])).status).toBe(403);
      expect((await importRows(A.users[u], [{ name: "Nope" }])).status).toBe(403);
    }
    expect(await PoItem().find({ tenant_id: A.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
  });
  test("another company's item -> 404 on edit / delete; invalid id -> 404; B unchanged", async () => {
    const before = await PoItem().findById(B.items.I2._id).lean();
    expect((await A.users.pricer.api.put(`${P}/items/${B.items.I2._id}`, { cost_price: 1 })).status).toBe(404);
    expect((await A.users.pricer.api.del(`${P}/items/${B.items.I2._id}`)).status).toBe(404);
    expect((await A.users.pricer.api.put(`${P}/items/not-an-id`, { cost_price: 1 })).status).toBe(404);
    expect((await A.users.pricer.api.del(`${P}/items/not-an-id`)).status).toBe(404);
    expect(await PoItem().findById(B.items.I2._id).lean()).toEqual(before);
  });
  test("a CRM Item id (Item model) as a PO line item_id -> 400 'pick the item from the PO items'; nothing saved", async () => {
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    for (const crm of [A.crmItems.widget, A.crmItems.i1]) {
      const r = await A.users.maker.api.post(P, sales([S.line(crm, 1)]));
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Line 1: pick the item from the PO items");
    }
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("CRM Items never show in the PO item list / picker / export", async () => {
    const all = (await A.users.admin.api.get(`${P}/items?active=all&limit=500`)).body.data.map((i) => i.name);
    expect(all).not.toContain("CRM Only Widget");
    expect(all).not.toContain("I1");
    expect((await A.users.admin.api.get(`${P}/items?search=CRM Only`)).body.total).toBe(0);
  });
  test("importing PO items creates NO CRM Items (Item count unchanged)", async () => {
    const before = await Item().countDocuments({});
    await importRows(A.users.pricer, [{ name: "No CRM Copy", item_code: "NCC-1", cost_price: 1 }, { name: "CRM Only Widget", cost_price: 2 }]);
    expect(await Item().countDocuments({})).toBe(before);
    // "CRM Only Widget" became a PO item of its own, the CRM Item is untouched
    expect(await PoItem().countDocuments({ tenant_id: A.tenantId, name: "CRM Only Widget" })).toBe(1);
    expect((await Item().findById(A.crmItems.widget._id).lean()).cost_price).toBe(5);
  });
  test("editing a CRM Item changes nothing in PO items", async () => {
    const before = await PoItem().find({ tenant_id: A.tenantId }).sort({ _id: 1 }).lean();
    await Item().updateOne({ _id: A.crmItems.i1._id }, { name: "I1 Label A", cost_price: 999, end_customer_price: 999 });
    expect(await PoItem().find({ tenant_id: A.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
    const r = await A.users.maker.api.post(P, sales([S.line(A.items.I1, 1)]));
    expect(r.body.items[0]).toMatchObject({ cost_price: 150, list_price: 160 });
  });
  test("bad query values: ?active=xyz -> 400; ?search[$ne]= is ignored (no operator injection)", async () => {
    expect((await A.users.viewer.api.get(`${P}/items?active=xyz`)).status).toBe(400);
    const r = await A.users.viewer.api.get(`${P}/items?search[$ne]=zzz&limit=500`);
    expect(r.status).toBe(200);
    expect(r.body.data.every((i) => String(i.tenant_id) === String(A.tenantId))).toBe(true);
  });
  test("Tenant C (add-on off) and Tenant D (not in PURCHASE_ORDERS_TENANT_IDS) -> 403 on every PO items endpoint", async () => {
    for (const T of [C, D]) {
      const api = T.users.admin.api;
      const id = T.items.I1._id;
      const res = [
        (await api.get(`${P}/items`)).status,
        (await api.get(`${P}/items/export`)).status,
        (await api.post(`${P}/items`, { name: "x" })).status,
        (await api.put(`${P}/items/${id}`, { cost_price: 1 })).status,
        (await api.del(`${P}/items/${id}`)).status,
        (await api.post(`${P}/items/import/preview`, { rows: [{ name: "x" }] })).status,
        (await api.post(`${P}/items/import`, { rows: [{ name: "x" }] })).status,
      ];
      expect(res).toEqual(Array(7).fill(403));
      expect((await PoItem().findById(id).lean()).cost_price).toBe(100);
    }
  });
  test("no token -> 401; noAccess staff -> 403", async () => {
    expect((await S.api(null).get(`${P}/items`)).status).toBe(401);
    expect((await A.users.noAccess.api.get(`${P}/items`)).status).toBe(403);
  });
});

describe("G0 INTEGRATION", () => {
  test("Excel upload -> items in the picker -> used on a PO -> 2nd upload changes the price -> new POs use it, the approved PO does not change", async () => {
    await importRows(A.users.pricer, [{ item_code: "FLW-1", name: "Flow Label", tax_rate: 18, cost_price: 100, end_customer_price: 160 }]);
    const it = (await A.users.maker.api.get(`${P}/items?active=true&search=FLW-1`)).body.data[0];
    expect(it).toMatchObject({ name: "Flow Label", cost_price: 100, end_customer_price: 160 });
    const pend = (await A.users.maker.api.post(P, sales([{ item_id: it._id, qty: 1 }], { submit: true }))).body;
    expect(pend.status).toBe("pending_approval"); // R4
    const appr = (await A.users.approver.api.post(`${P}/${pend._id}/approve`, {})).body;
    expect(appr.status).toBe("approved");
    await importRows(A.users.pricer, [{ item_code: "FLW-1", cost_price: 120, end_customer_price: 200 }]);
    const fresh = (await A.users.maker.api.post(P, sales([{ item_id: it._id, qty: 1 }]))).body;
    expect(fresh.items[0]).toMatchObject({ cost_price: 120, list_price: 200, selling_price: 200 });
    expect((await A.users.maker.api.get(`${P}/${appr._id}`)).body.items[0]).toMatchObject({ cost_price: 100, list_price: 160, selling_price: 160 });
  });

  test("a fresh company starts with an EMPTY PO items list, even with CRM Items carrying PO prices", async () => {
    const E = await S.seedTenant("E");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${E.tenantId}`;
    await PoItem().deleteMany({ tenant_id: E.tenantId }); // a company that never added PO items
    await Item().create({ name: "Legacy Priced", tenant_id: E.tenantId, item_code: "LP-1", cost_price: 10, master_price: 11, distributor_price: 12, end_customer_price: 13 });
    const r = await E.users.admin.api.get(`${P}/items?active=all`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 0, data: [] });
    expect((await E.users.admin.api.get(`${P}/items/export`)).body.rows).toEqual([]);
  });

  test("an old PO whose lines point at CRM Items still opens, reprints from its snapshot and can be edited (snapshot kept)", async () => {
    const crm = A.crmItems.widget;
    const legacy = await PurchaseOrder().create({
      tenant_id: A.tenantId, type: "purchase", division: "brady", po_number: "PPO-LEGACY-0001", customer: A.customers.c1._id,
      customer_snapshot: { name: "Acme A" }, created_by: A.users.maker.id, status: "draft", format_version: 1,
      items: [{ item_id: crm._id, item_code: "OLD-W", name: "Old Widget", hsn: "1111", unit: "Nos", qty: 2, cost_price: 40, list_price: 60, selling_price: 60, rate: 60, amount: 120, tax_rate: 18, tax_amount: 21.6 }],
      totals: { subtotal: 120, tax_total: 21.6, grand_total: 141.6 },
    });
    const g = await A.users.maker.api.get(`${P}/${legacy._id}`);
    expect(g.status).toBe(200);
    expect(g.body.items[0]).toMatchObject({ item_code: "OLD-W", name: "Old Widget", cost_price: 40, list_price: 60 });
    expect(g.body.format).toBeDefined();
    const e = await A.users.maker.api.put(`${P}/${legacy._id}`, sales([{ item_id: String(crm._id), qty: 3, selling_price: 60 }]));
    expect(e.status).toBe(200);
    // still the saved copy, never the CRM Item's own values (cost 5 / 9)
    expect(e.body.items[0]).toMatchObject({ item_code: "OLD-W", name: "Old Widget", qty: 3, cost_price: 40, list_price: 60 });
  });

  test("company separation + View (Own): own staff can read the list (picker) but not change it; lists never include B", async () => {
    const own = await A.users.own.api.get(`${P}/items?limit=500`);
    expect(own.status).toBe(200);
    expect(own.body.data.every((i) => String(i.tenant_id) === String(A.tenantId))).toBe(true);
    expect((await A.users.own.api.get(`${P}/items/export`)).status).toBe(200);
    expect((await A.users.own.api.post(`${P}/items`, { name: "Own item" })).status).toBe(403);
    const b = (await B.users.admin.api.get(`${P}/items?limit=500`)).body.data;
    expect(b.every((i) => String(i.tenant_id) === String(B.tenantId))).toBe(true);
  });
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
