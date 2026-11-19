// Items — POSITIVE API tests (/api/items) on an in-memory MongoDB.
// For each action: the API returns it AND the DB record matches.
// Each test states the CORRECT behaviour; a failing test is a bug found.
const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

jest.setTimeout(120000);

let A;
let api;
let db;
let taxA18;
let cf;
const Item = () => require("../../models/Item");

beforeAll(async () => {
  await start([
    ["/api/items", "routes/item_routes"],
    ["/api/invoices", "routes/invoice_routes"],
    ["/api/estimates", "routes/estimate_routes"],
  ]);
  db = mongoose.connection.db;
  A = await seedCompany("A", ["Items", "Invoices", "Estimates"]);
  api = client(A.admin.token);
  taxA18 = (await db.collection("taxes").insertOne({ name: "GST 18%", taxrate: 18, tenant_id: A.tenantId })).insertedId;
  await db.collection("hrmsbranches").insertOne({ name: "Mumbai", tenant_id: A.tenantId });
  cf = (await db.collection("customfields").insertOne({
    name: "Colour", slug: "items_colour", fieldto: "items", type: "input", active: true, required: false, show_on_table: true,
  })).insertedId;
});
afterAll(stop);

const full = () => ({
  branch: "Mumbai", name: "Laptop Stand", long_description: "Aluminium stand", quantity: 2, rate: 1200, amount: 2400,
  unit: "Nos", group: "Accessories", tax: String(taxA18), hsn_sac_code: "8473", cess_rate: 1, tax_inclusive: true,
  custom_fields: { [String(cf)]: "Silver" },
});

describe("Positive: create", () => {
  test("only Branch + Name → 201 with defaults, DB matches", async () => {
    const r = await api.post("/api/items", { branch: "Mumbai", name: "Minimal" });
    expect(r.status).toBe(201);
    const d = await Item().findById(r.body._id).lean();
    expect(d).toMatchObject({ name: "Minimal", branch: "Mumbai", quantity: 1, rate: 0, amount: 0, cess_rate: 0, tax_inclusive: false });
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });

  test("ALL fields incl. a custom field → 201, DB + custom field value saved", async () => {
    const r = await api.post("/api/items", full());
    expect(r.status).toBe(201);
    expect(r.body.custom_fields).toEqual({ items_colour: "Silver" });
    const d = await Item().findById(r.body._id).lean();
    const { custom_fields, tax, ...rest } = full();
    expect(d).toMatchObject(rest);
    expect(String(d.tax)).toBe(tax);
    const v = await db.collection("customfieldvalues").findOne({ relid: d._id, fieldto: "items" });
    expect(v?.value).toBe("Silver");
  });

  test("GET list returns the item with tax populated and custom_fields", async () => {
    const r = await api.get("/api/items");
    expect(r.status).toBe(200);
    const it = r.body.find((i) => i.name === "Laptop Stand");
    expect(it.tax).toMatchObject({ name: "GST 18%", taxrate: 18 });
    expect(it.custom_fields).toEqual({ items_colour: "Silver" });
  });
});

describe("Positive: edit every field, delete", () => {
  let id;
  beforeAll(async () => { id = (await api.post("/api/items", { ...full(), name: "Laptop Stand (edit)" })).body._id; });

  test("PUT changes every field; DB matches", async () => {
    const tax12 = (await db.collection("taxes").insertOne({ name: "GST 12%", taxrate: 12, tenant_id: A.tenantId })).insertedId;
    await db.collection("hrmsbranches").insertOne({ name: "Pune", tenant_id: A.tenantId });
    const upd = {
      branch: "Pune", name: "Laptop Stand v2", long_description: "Steel", quantity: 3, rate: 1000, amount: 3000,
      unit: "Pcs", group: "Office", tax: String(tax12), hsn_sac_code: "847330", cess_rate: 2, tax_inclusive: false,
      custom_fields: { [String(cf)]: "Black" },
    };
    const r = await api.put(`/api/items/${id}`, upd);
    expect(r.status).toBe(200);
    expect(r.body.custom_fields).toEqual({ items_colour: "Black" });
    const d = await Item().findById(id).lean();
    const { custom_fields, tax, ...rest } = upd;
    expect(d).toMatchObject(rest);
    expect(String(d.tax)).toBe(String(tax12));
  });

  test("PUT tax: null (edit form 'No Tax') clears the tax", async () => {
    const r = await api.put(`/api/items/${id}`, { name: "Laptop Stand v2", tax: null });
    expect(r.status).toBe(200);
    expect((await Item().findById(id).lean()).tax).toBeNull();
  });

  test("DELETE → 200 and gone from DB", async () => {
    const r = await api.del(`/api/items/${id}`);
    expect(r.status).toBe(200);
    expect(await Item().findById(id)).toBeNull();
  });
});

describe("Positive: search, branch filter, pages", () => {
  beforeAll(async () => {
    await Item().deleteMany({});
    const docs = [];
    for (let i = 1; i <= 23; i++) docs.push({ name: `Widget ${i}`, branch: i <= 10 ? "Mumbai" : "Pune", tenant_id: A.tenantId });
    docs.push({ name: "Taxed thing", tax: taxA18, tenant_id: A.tenantId, branch: "Pune" });
    await Item().insertMany(docs);
  });

  test("search by name", async () => {
    const r = await api.get("/api/items?search=widget%201&limit=50");
    expect(r.status).toBe(200);
    // Widget 1, 10..19
    expect(r.body.total).toBe(11);
  });

  test("search by tax name finds items with that tax", async () => {
    const r = await api.get("/api/items?search=GST%2018");
    expect(r.body.data.map((i) => i.name)).toEqual(["Taxed thing"]);
  });

  test("branch filter", async () => {
    const r = await api.get("/api/items?branch=Mumbai&limit=50");
    expect(r.body.total).toBe(10);
    expect(r.body.data.every((i) => i.branch === "Mumbai")).toBe(true);
  });

  test("pages: limit 10 → 3 pages, last page has 4", async () => {
    const r = await api.get("/api/items?page=3&limit=10");
    expect(r.body).toMatchObject({ total: 24, pages: 3, page: 3 });
    expect(r.body.data).toHaveLength(4);
  });
});

describe("Positive: import 3 rows, bulk Mass Delete", () => {
  test("import 3 rows → count 3, fields mapped, tax matched by name", async () => {
    await Item().deleteMany({});
    const rows = [
      { "Item Name": "Imp A", Group: "G1", Description: "desc A", Quantity: 10, Rate: 1200, Amount: 12000, Unit: "Box", Tax: "GST 18%", "HSN/SAC": "8473", Branch: "Mumbai" },
      { "Item Name": "Imp B", Rate: "₹ 1,500.50" },
      { Name: "Imp C", "Cess Rate": 2, "Tax Inclusive": "Yes" },
    ];
    const r = await api.post("/api/items/import", rows);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ count: 3, skipped: 0 });
    const a = await Item().findOne({ name: "Imp A" }).lean();
    expect(a).toMatchObject({ group: "G1", long_description: "desc A", quantity: 10, rate: 1200, amount: 12000, unit: "Box", hsn_sac_code: "8473", branch: "Mumbai" });
    expect(String(a.tax)).toBe(String(taxA18));
    const b = await Item().findOne({ name: "Imp B" }).lean();
    expect(b).toMatchObject({ rate: 1500.5, quantity: 1, amount: 1500.5, unit: "Nos" });
    const c = await Item().findOne({ name: "Imp C" }).lean();
    expect(c).toMatchObject({ cess_rate: 2, tax_inclusive: true });
  });

  test("import maps a custom field column by its name", async () => {
    const r = await api.post("/api/items/import", [{ "Item Name": "Imp CF", Colour: "Green" }]);
    expect(r.status).toBe(201);
    const it = await Item().findOne({ name: "Imp CF" }).lean();
    const v = await db.collection("customfieldvalues").findOne({ relid: it._id });
    expect(v?.value).toBe("Green");
  });

  test("bulk-delete 2 of them → count 2", async () => {
    const ids = (await Item().find({ name: { $in: ["Imp A", "Imp B"] } }).lean()).map((i) => String(i._id));
    const r = await api.post("/api/items/bulk-delete", { ids });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(await Item().countDocuments({ name: { $in: ["Imp A", "Imp B"] } })).toBe(0);
  });
});

describe("Positive: new item works on Invoice / Estimate (rate, unit, tax, HSN)", () => {
  let item;
  let clientId;
  beforeAll(async () => {
    clientId = (await db.collection("clients").insertOne({ company: "Buyer Ltd", tenant_id: A.tenantId })).insertedId;
    const id = (await api.post("/api/items", { name: "Service X", rate: 500, unit: "Hrs", tax: String(taxA18), hsn_sac_code: "998314" })).body._id;
    item = (await api.get("/api/items")).body.find((i) => i._id === id);
  });

  // Same mapping as InvoiceCreate.tsx:1031-1052 (picker) + :533-545 (submit).
  const lineFrom = (it) => ({
    description: it.name, long_description: it.long_description || "", qty: 1, rate: it.rate, unit: it.unit,
    itemHSN: it.hsn_sac_code, itemGroup: it.group || "", tax: it.tax.taxrate, tax_name: it.tax.name,
    gstPercentage: it.tax.taxrate, amount: it.rate,
  });

  test("invoice line carries rate, unit, HSN and 18% tax", async () => {
    // The frontend also sends its own total_tax (InvoiceCreate.tsx:552).
    const r = await api.post("/api/invoices", { client: String(clientId), number: "INV-ITEM-1", items: [lineFrom(item)], total_tax: 90 });
    expect(r.status).toBe(201);
    expect(r.body.items[0]).toMatchObject({ description: "Service X", rate: 500, unit: "Hrs", itemHSN: "998314", tax: 18 });
    expect(r.body.subtotal).toBe(500);
    expect(r.body.total).toBe(590);
  });

  test("estimate line carries rate, unit, HSN and 18% tax", async () => {
    const r = await api.post("/api/estimates", { client: String(clientId), number: "EST-ITEM-1", items: [lineFrom(item)] });
    expect(r.status).toBe(201);
    expect(r.body.items[0]).toMatchObject({ description: "Service X", rate: 500, tax: 18 });
    expect(r.body.total).toBe(590);
    // EstimateCreate.tsx:763 sends the item's unit; the saved line must keep it.
    expect(r.body.items[0].unit).toBe("Hrs");
    expect(r.body.items[0].itemHSN).toBe(item.hsn_sac_code);
  });
});
