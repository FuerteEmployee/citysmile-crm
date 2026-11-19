// Items — INTEGRATION tests: permissions (incl. key casing), tenant isolation,
// tax link, branch rename, rate change vs. old invoices, custom-field cleanup.
// Each test states the CORRECT behaviour; a failing test is a bug found.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

jest.setTimeout(120000);

let A;
let B;
let db;
const Item = () => require("../../models/Item");

const addStaff = async (company, label, extra) => {
  const _id = new mongoose.Types.ObjectId();
  await db.collection("staffs").insertOne({
    _id, firstname: label, lastname: "X", email: `${label}.${_id}@crm-test.local`, password: "x",
    active: true, tenant_id: company.tenantId, admin: false, ...extra,
  });
  return client(jwt.sign({ id: String(_id), role: "staff" }, process.env.JWT_SECRET));
};
const mkItem = (tenantId, extra = {}) => Item().create({ name: `It ${Math.random().toString(36).slice(2, 8)}`, tenant_id: tenantId, ...extra });

beforeAll(async () => {
  await start([
    ["/api/items", "routes/item_routes"],
    ["/api/invoices", "routes/invoice_routes"],
    ["/api/taxes", "routes/tax_routes"],
    ["/api/hrms", "hrms/routes/index"],
  ]);
  require("../../models/QuotationType"); // HRMS branch populate needs it registered
  db = mongoose.connection.db;
  A = await seedCompany("A", ["Items", "Invoices"]);
  B = await seedCompany("B", ["Items"]);
});
afterAll(stop);

describe("Permissions (route keys: 'Items' + 'view'/'create'/'edit'/'delete')", () => {
  const writeCalls = async (api, tenantId) => {
    const target = await mkItem(tenantId);
    const target2 = await mkItem(tenantId);
    return {
      create: (await api.post("/api/items", { name: `perm create ${Math.random()}` })).status,
      edit: (await api.put(`/api/items/${target._id}`, { name: "perm edit" })).status,
      delete: (await api.del(`/api/items/${target._id}`)).status,
      import: (await api.post("/api/items/import", [{ "Item Name": `perm import ${Math.random()}` }])).status,
      bulkDelete: (await api.post("/api/items/bulk-delete", { ids: [String(target2._id)] })).status,
    };
  };

  test("admin: all allowed", async () => {
    const s = await writeCalls(client(A.admin.token), A.tenantId);
    expect(s).toEqual({ create: 201, edit: 200, delete: 200, import: 201, bulkDelete: 200 });
  });

  test("Items → View(Global) only: GET 200 (no wrong 403)", async () => {
    expect((await client(A.viewOnly.token).get("/api/items")).status).toBe(200);
  });

  test("Items → View(Global) only: POST/PUT/DELETE/import/bulk-delete → 403", async () => {
    const s = await writeCalls(client(A.viewOnly.token), A.tenantId);
    expect(s).toEqual({ create: 403, edit: 403, delete: 403, import: 403, bulkDelete: 403 });
  });

  test("full staff (View+Create+Edit+Delete): all allowed", async () => {
    const s = await writeCalls(client(A.full.token), A.tenantId);
    expect(s).toEqual({ create: 201, edit: 200, delete: 200, import: 201, bulkDelete: 200 });
  });

  test("no Items permission: GET → 403 and writes → 403", async () => {
    const api = client(A.noAccess.token);
    expect((await api.get("/api/items")).status).toBe(403);
    const s = await writeCalls(api, A.tenantId);
    expect(s).toEqual({ create: 403, edit: 403, delete: 403, import: 403, bulkDelete: 403 });
  });

  test("Create-only staff (no View): can create, no wrong 403", async () => {
    const api = await addStaff(A, "creator", { permissions: { Items: { Create: true } } });
    expect((await api.post("/api/items", { name: "create-only" })).status).toBe(201);
  });

  test("role-based: role grants Items View(Global) → GET 200, POST 403", async () => {
    const roleId = (await db.collection("roles").insertOne({ name: "Item viewer role", permissions: { Items: { "View(Global)": true } } })).insertedId;
    const api = await addStaff(A, "roleviewer", { role: roleId });
    expect((await api.get("/api/items")).status).toBe(200);
    expect((await api.post("/api/items", { name: "role write" })).status).toBe(403);
  });

  test("key casing: lowercase 'items'/'view(global)' keys are NOT treated as Items access (backend is case-sensitive)", async () => {
    // Documents how checkPermission matches keys; the UI always saves "Items"/"View(Global)".
    const api = await addStaff(A, "lowercase", { permissions: { items: { "view(global)": true, create: true } } });
    expect((await api.get("/api/items")).status).toBe(403);
  });
});

describe("Tenant isolation (A vs B)", () => {
  let bItem;
  const apiA = () => client(A.admin.token);
  beforeAll(async () => { bItem = await mkItem(B.tenantId, { name: "B private item", rate: 99 }); });

  test("A's list (bare + paged + search) never contains B's items", async () => {
    const bare = await apiA().get("/api/items");
    expect(bare.body.some((i) => i._id === String(bItem._id))).toBe(false);
    const s = await apiA().get("/api/items?search=B%20private");
    expect(s.body.total).toBe(0);
  });

  test("A cannot edit B's item (404/403, B's DB unchanged)", async () => {
    const r = await apiA().put(`/api/items/${bItem._id}`, { name: "edited by A", rate: 1 });
    expect([403, 404]).toContain(r.status);
    const d = await Item().findById(bItem._id).lean();
    expect(d).toMatchObject({ name: "B private item", rate: 99 });
  });

  test("A cannot delete B's item (404/403, still exists)", async () => {
    const victim = await mkItem(B.tenantId, { name: "B delete victim" });
    const r = await apiA().del(`/api/items/${victim._id}`);
    expect([403, 404]).toContain(r.status);
    expect(await Item().findById(victim._id)).not.toBeNull();
  });

  test("A cannot bulk-delete B's items", async () => {
    const victim = await mkItem(B.tenantId);
    const r = await apiA().post("/api/items/bulk-delete", { ids: [String(victim._id)] });
    expect(r.body.count).toBe(0);
    expect(await Item().findById(victim._id)).not.toBeNull();
  });

  test("A cannot move its own item into B via PUT tenant_id", async () => {
    const mine = await mkItem(A.tenantId);
    await apiA().put(`/api/items/${mine._id}`, { name: mine.name, tenant_id: String(B.tenantId) });
    const bList = await client(B.admin.token).get("/api/items");
    expect(bList.body.some((i) => i._id === String(mine._id))).toBe(false);
  });

  test("import duplicate check is per tenant: A can import a name B already has", async () => {
    const r = await apiA().post("/api/items/import", [{ "Item Name": "B private item" }]);
    expect(r.body.count).toBe(1);
  });

  test("import tax lookup is per tenant: B's tax name is not linked on A's item", async () => {
    await db.collection("taxes").insertOne({ name: "B-only VAT", taxrate: 9, tenant_id: B.tenantId });
    await apiA().post("/api/items/import", [{ "Item Name": "Imp with B tax", Tax: "B-only VAT" }]);
    const d = await Item().findOne({ name: "Imp with B tax" }).lean();
    expect(d.tax).toBeUndefined();
  });

  // B's field carries B's tenant_id, as every field created after the per-company change does.
  test("custom field defined by Tenant B is not usable/visible on Tenant A's items", async () => {
    const cfB = (await db.collection("customfields").insertOne({ name: "B internal code", slug: "items_b_internal", fieldto: "items", type: "input", active: true, tenant_id: B.tenantId })).insertedId;
    const r = await apiA().post("/api/items", { name: "A with B cf", custom_fields: { [String(cfB)]: "leak" } });
    expect(r.status).toBe(201);
    expect(r.body.custom_fields || {}).toEqual({});
    expect(await db.collection("customfieldvalues").countDocuments({ fieldid: cfB })).toBe(0);
  });
  test("Tenant A's custom field list does not include Tenant B's fields", async () => {
    await db.collection("customfields").insertOne({ name: "B only", slug: "items_b_only", fieldto: "items", type: "input", active: true, tenant_id: B.tenantId });
    const CustomFieldService = require("../../services/CustomFieldService");
    const visible = (await CustomFieldService.getFieldsFor("items", A.tenantId)).map((f) => f.slug);
    expect(visible).not.toContain("items_b_only");
  });
});

describe("Tax link", () => {
  let api;
  let taxId;
  let item;
  let clientId;
  beforeAll(async () => {
    api = client(A.admin.token);
    taxId = (await db.collection("taxes").insertOne({ name: "GST 18%", taxrate: 18, tenant_id: A.tenantId })).insertedId;
    clientId = (await db.collection("clients").insertOne({ company: "Buyer", tenant_id: A.tenantId })).insertedId;
    const id = (await api.post("/api/items", { name: "Taxed svc", rate: 1000, tax: String(taxId) })).body._id;
    item = (await api.get("/api/items")).body.find((i) => i._id === id);
  });

  test("invoice line built from the item uses the item's tax % (18)", async () => {
    const r = await api.post("/api/invoices", {
      client: String(clientId), number: "INV-TAX-1",
      items: [{ description: item.name, qty: 1, rate: item.rate, tax: item.tax.taxrate, tax_name: item.tax.name, gstPercentage: item.tax.taxrate, amount: item.rate }],
    });
    expect(r.status).toBe(201);
    expect(r.body.items[0].tax).toBe(18);
    expect(r.body.total).toBe(1180);
  });

  test("changing the tax rate: item shows new %, old invoice keeps 18%", async () => {
    await db.collection("taxes").updateOne({ _id: taxId }, { $set: { taxrate: 12 } });
    const it = (await api.get("/api/items")).body.find((i) => i._id === item._id);
    expect(it.tax.taxrate).toBe(12);
    const inv = await db.collection("invoices").findOne({ number: "INV-TAX-1" });
    expect(inv.items[0].tax).toBe(18);
    expect(inv.total).toBe(1180);
  });

  test("deleting the tax: item list still loads, item shows no tax, and no dangling tax id is left", async () => {
    const del = await api.del(`/api/taxes/${taxId}`);
    expect(del.status).toBe(200);
    const r = await api.get("/api/items");
    expect(r.status).toBe(200);
    expect(r.body.find((i) => i._id === item._id).tax ?? null).toBeNull();
    const d = await Item().findById(item._id).lean();
    expect(d.tax ?? null).toBeNull();
  });

  test("Tenant A admin cannot delete Tenant B's tax used by B's items", async () => {
    const bTax = (await db.collection("taxes").insertOne({ name: "B GST", taxrate: 5, tenant_id: B.tenantId })).insertedId;
    await mkItem(B.tenantId, { name: "B taxed", tax: bTax });
    const r = await api.del(`/api/taxes/${bTax}`);
    expect([403, 404]).toContain(r.status);
    expect(await db.collection("taxes").findOne({ _id: bTax })).not.toBeNull();
  });
});

describe("Branch rename / rate change", () => {
  // Rename goes through the real HRMS branch API, which carries the new name onto items.
  test("after an HRMS branch is renamed, its items still show under the branch filter", async () => {
    const api = client(A.admin.token);
    const br = (await db.collection("hrmsbranches").insertOne({ name: "Surat", tenant_id: A.tenantId })).insertedId;
    await api.post("/api/items", { name: "Surat item", branch: "Surat" });
    const hrms = client(jwt.sign({ id: String(A.admin.id) }, process.env.JWT_SECRET));
    expect((await hrms.patch(`/api/hrms/hrms-branches/${br}`, { name: "Surat HQ" })).status).toBe(200);
    const r = await api.get("/api/items?branch=Surat%20HQ&page=1&limit=50");
    expect(r.body.data.map((i) => i.name)).toContain("Surat item");
  });

  test("branch filter alone (no page/limit) is still applied", async () => {
    const api = client(A.admin.token);
    await api.post("/api/items", { name: "Vapi item", branch: "Vapi" });
    const r = await api.get("/api/items?branch=Vapi");
    const rows = Array.isArray(r.body) ? r.body : r.body.data;
    expect(rows.every((i) => i.branch === "Vapi")).toBe(true);
  });

  test("rate change on the item does not alter old invoice lines", async () => {
    const api = client(A.admin.token);
    const clientId = (await db.collection("clients").insertOne({ company: "C2", tenant_id: A.tenantId })).insertedId;
    const it = (await api.post("/api/items", { name: "Rate item", rate: 100 })).body;
    await api.post("/api/invoices", { client: String(clientId), number: "INV-RATE-1", items: [{ description: it.name, qty: 1, rate: it.rate, amount: it.rate }] });
    await api.put(`/api/items/${it._id}`, { name: it.name, rate: 150 });
    const inv = await db.collection("invoices").findOne({ number: "INV-RATE-1" });
    expect(inv.items[0].rate).toBe(100);
    expect(inv.total).toBe(100);
  });
});

describe("Custom field values follow the item lifecycle", () => {
  test("deleting an item removes its custom field values", async () => {
    const api = client(A.admin.token);
    const cf = (await db.collection("customfields").insertOne({ name: "Shelf", slug: "items_shelf", fieldto: "items", type: "input", active: true })).insertedId;
    const it = (await api.post("/api/items", { name: "Shelf item", custom_fields: { [String(cf)]: "S1" } })).body;
    await api.del(`/api/items/${it._id}`);
    expect(await db.collection("customfieldvalues").countDocuments({ relid: new mongoose.Types.ObjectId(it._id) })).toBe(0);
  });

  test("bulk-deleting items removes their custom field values", async () => {
    const api = client(A.admin.token);
    const cf = (await db.collection("customfields").findOne({ slug: "items_shelf" }))._id;
    const it = (await api.post("/api/items", { name: "Shelf item 2", custom_fields: { [String(cf)]: "S2" } })).body;
    await api.post("/api/items/bulk-delete", { ids: [it._id] });
    expect(await db.collection("customfieldvalues").countDocuments({ relid: new mongoose.Types.ObjectId(it._id) })).toBe(0);
  });
});
