// Items — NEGATIVE API tests: every field on POST /api/items and PUT /api/items/:id,
// plus auth, bad ids, protected fields, import, bulk delete, double submit.
// Each test states the CORRECT behaviour; a failing test is a bug found.
// "reject" = 400/409/422, nothing saved/changed, and never a 500.
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

jest.setTimeout(120000);

let A;
let B;
let api;
let db;
const ids = {};
const Item = () => require("../../models/Item");
const REJECT = [400, 409, 422];

beforeAll(async () => {
  await start([
    ["/api/items", "routes/item_routes"],
    ["/api/invoices", "routes/invoice_routes"],
  ]);
  db = mongoose.connection.db;
  A = await seedCompany("A", ["Items", "Invoices"]);
  B = await seedCompany("B", ["Items"]);
  api = client(A.admin.token);
  await db.collection("hrmsbranches").insertMany([
    { name: "Mumbai", tenant_id: A.tenantId },
    { name: "Delhi-B", tenant_id: B.tenantId },
  ]);
  ids.taxA = String((await db.collection("taxes").insertOne({ name: "GST 18%", taxrate: 18, tenant_id: A.tenantId })).insertedId);
  ids.taxB = String((await db.collection("taxes").insertOne({ name: "B secret 7%", taxrate: 7, tenant_id: B.tenantId })).insertedId);
  ids.taxDeleted = String((await db.collection("taxes").insertOne({ name: "Old 5%", taxrate: 5, tenant_id: A.tenantId })).insertedId);
  await db.collection("taxes").deleteOne({ _id: new mongoose.Types.ObjectId(ids.taxDeleted) });
  ids.cfReq = String((await db.collection("customfields").insertOne({ name: "Brand", slug: "items_brand", fieldto: "items", type: "input", active: true, required: true })).insertedId);
  ids.cfNum = String((await db.collection("customfields").insertOne({ name: "Warranty Months", slug: "items_warranty", fieldto: "items", type: "number", active: true, required: false })).insertedId);
});
afterAll(stop);

const base = () => ({ branch: "Mumbai", name: `Neg ${Math.random().toString(36).slice(2, 9)}`, custom_fields: { [ids.cfReq]: "Acme" } });
const S = (n, ch = "a") => ch.repeat(n);

// [field, label, patch(), expectation]
// expectation: "reject" | (res, doc) => assertions for an accepted value
const ok = (field, value) => (res, doc) => { expect(res.status).toBeLessThan(300); expect(doc[field]).toEqual(value); };
const CASES = [
  ["branch", "branch name that doesn't exist", () => ({ branch: "Atlantis" }), "reject"],
  ["branch", "Tenant B's branch name", () => ({ branch: "Delhi-B" }), "reject"],

  ["name", "empty", () => ({ name: "" }), "reject"],
  ["name", "spaces only", () => ({ name: "    " }), "reject"],
  ["name", "1 char", () => ({ name: "Z" }), ok("name", "Z")],
  ["name", "300 chars (max, saved intact)", () => ({ name: S(300, "N") }), ok("name", S(300, "N"))],
  ["name", "500 chars (over the 300 max)", () => ({ name: S(500, "N") }), "reject"],
  ["name", "<script> stored as plain text", () => ({ name: "<script>alert(1)</script>" }), ok("name", "<script>alert(1)</script>")],
  ["name", "emoji saved intact", () => ({ name: "Cake 🎂🍰" }), ok("name", "Cake 🎂🍰")],

  ["long_description", "5001 chars (over the 5000 max)", () => ({ long_description: S(5001, "d") }), "reject"],
  ["long_description", "5000 chars", () => ({ long_description: S(5000, "d") }), ok("long_description", S(5000, "d"))],
  ["long_description", "HTML/script stored as plain text", () => ({ long_description: "<img src=x onerror=alert(1)>" }), ok("long_description", "<img src=x onerror=alert(1)>")],

  ["quantity", "0 (saved as 0, not 1)", () => ({ quantity: 0 }), ok("quantity", 0)],
  ["quantity", "-5", () => ({ quantity: -5 }), "reject"],
  ["quantity", "1.5", () => ({ quantity: 1.5 }), ok("quantity", 1.5)],
  ["quantity", "1e10", () => ({ quantity: 1e10 }), ok("quantity", 1e10)],
  ["quantity", "'abc'", () => ({ quantity: "abc" }), "reject"],
  ["quantity", "empty string → default 1 or reject (never null)", () => ({ quantity: "" }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.quantity).toBe(1); } }],

  ["rate", "-100", () => ({ rate: -100 }), "reject"],
  ["rate", "0", () => ({ rate: 0 }), ok("rate", 0)],
  ["rate", "0.001", () => ({ rate: 0.001 }), ok("rate", 0.001)],
  ["rate", "99999999999", () => ({ rate: 99999999999 }), ok("rate", 99999999999)],
  ["rate", "'abc'", () => ({ rate: "abc" }), "reject"],
  ["rate", "empty string → 0 or reject (never null)", () => ({ rate: "" }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.rate).toBe(0); } }],

  ["amount", "≠ quantity × rate (2 × 10, amount 999)", () => ({ quantity: 2, rate: 10, amount: 999 }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.amount).toBe(20); } }],
  ["amount", "negative", () => ({ amount: -50 }), "reject"],
  ["amount", "'abc'", () => ({ amount: "abc" }), "reject"],

  ["unit", "50 chars (max)", () => ({ unit: S(50, "u") }), ok("unit", S(50, "u"))],
  ["unit", "100 chars (over the 50 max)", () => ({ unit: S(100, "u") }), "reject"],
  ["unit", "HTML stored as plain text", () => ({ unit: "<b>kg</b>" }), ok("unit", "<b>kg</b>")],
  ["group", "100 chars (max)", () => ({ group: S(100, "g") }), ok("group", S(100, "g"))],
  ["group", "300 chars (over the 100 max)", () => ({ group: S(300, "g") }), "reject"],
  ["group", "HTML stored as plain text", () => ({ group: "<i>x</i>" }), ok("group", "<i>x</i>")],

  ["tax", "Tenant B's tax id", () => ({ tax: ids.taxB }), "reject"],
  ["tax", "deleted tax id", () => ({ tax: ids.taxDeleted }), "reject"],
  ["tax", "invalid id 'xyz'", () => ({ tax: "xyz" }), "reject"],
  ["tax", "'none' → reject or no tax (never 500)", () => ({ tax: "none" }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.tax ?? null).toBeNull(); } }],

  ["hsn_sac_code", "letters 'ABCD'", () => ({ hsn_sac_code: "ABCD" }), "reject"],
  ["hsn_sac_code", "3 digits", () => ({ hsn_sac_code: "123" }), "reject"],
  ["hsn_sac_code", "10 digits", () => ({ hsn_sac_code: "1234567890" }), "reject"],
  ["hsn_sac_code", "valid 8 digits", () => ({ hsn_sac_code: "84733020" }), ok("hsn_sac_code", "84733020")],

  ["cess_rate", "-1", () => ({ cess_rate: -1 }), "reject"],
  ["cess_rate", "101", () => ({ cess_rate: 101 }), "reject"],
  ["cess_rate", "1000", () => ({ cess_rate: 1000 }), "reject"],
  ["cess_rate", "'abc'", () => ({ cess_rate: "abc" }), "reject"],

  ["custom_fields", "required custom field empty", () => ({ custom_fields: { [ids.cfReq]: "" } }), "reject"],
  ["custom_fields", "number custom field given 'abc'", () => ({ custom_fields: { [ids.cfReq]: "Acme", [ids.cfNum]: "abc" } }), "reject"],

  ["tax_inclusive", "'yes' → true or reject", () => ({ tax_inclusive: "yes" }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.tax_inclusive).toBe(true); } }],
  ["tax_inclusive", "1 → true or reject", () => ({ tax_inclusive: 1 }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.tax_inclusive).toBe(true); } }],
  ["tax_inclusive", "null → false or reject (never null)", () => ({ tax_inclusive: null }),
    (res, doc) => { if (!REJECT.includes(res.status)) { expect(res.status).toBeLessThan(300); expect(doc.tax_inclusive).toBe(false); } }],
];

const cfValue = async (itemId, cfId) => (await db.collection("customfieldvalues").findOne({
  relid: new mongoose.Types.ObjectId(String(itemId)), fieldid: new mongoose.Types.ObjectId(cfId),
}))?.value;

describe("Negative: every field on POST /api/items", () => {
  test.each(CASES)("POST %s: %s", async (field, _label, patch, expectation) => {
    const before = await Item().countDocuments({});
    const res = await api.post("/api/items", { ...base(), ...patch() });
    expect(res.status).not.toBe(500);
    if (expectation === "reject") {
      expect(REJECT).toContain(res.status);
      expect(await Item().countDocuments({})).toBe(before);
    } else {
      const doc = res.body?._id ? await Item().findById(res.body._id).lean() : {};
      expectation(res, doc || {});
    }
  });

  test("POST duplicate name in the same tenant + branch is rejected", async () => {
    const r1 = await api.post("/api/items", { ...base(), name: "Dup Name" });
    expect(r1.status).toBe(201);
    const r2 = await api.post("/api/items", { ...base(), name: "Dup Name" });
    expect(REJECT).toContain(r2.status);
    expect(await Item().countDocuments({ name: "Dup Name" })).toBe(1);
  });

  test("duplicate name differing only in case → 409; same name in another branch is allowed", async () => {
    await db.collection("hrmsbranches").insertOne({ name: "Pune", tenant_id: A.tenantId });
    expect((await api.post("/api/items", { ...base(), name: "Case Dup" })).status).toBe(201);
    expect((await api.post("/api/items", { ...base(), name: "  case DUP " })).status).toBe(409);
    expect((await api.post("/api/items", { ...base(), branch: "Pune", name: "Case Dup" })).status).toBe(201);
  });

  test("tax '' → saved with no tax", async () => {
    const r = await api.post("/api/items", { ...base(), tax: "" });
    expect(r.status).toBe(201);
    expect((await Item().findById(r.body._id).lean()).tax ?? null).toBeNull();
  });

  test("Tenant B's tax on an A item must not leak B's tax name/rate via GET", async () => {
    await api.post("/api/items", { ...base(), name: "Leak probe", tax: ids.taxB });
    const r = await api.get("/api/items");
    const it = r.body.find((i) => i.name === "Leak probe");
    if (it) expect(it.tax?.name).not.toBe("B secret 7%");
  });
});

describe("Negative: every field on PUT /api/items/:id", () => {
  // Start clean so names saved by the POST cases do not collide (duplicate-name rule).
  beforeAll(async () => { await Item().deleteMany({}); });
  test.each(CASES)("PUT %s: %s", async (field, _label, patch, expectation) => {
    const orig = (await api.post("/api/items", { ...base(), quantity: 3, rate: 7, amount: 21, tax: ids.taxA, hsn_sac_code: "8473", cess_rate: 1, unit: "Nos", group: "G", long_description: "orig" })).body;
    const before = await Item().findById(orig._id).lean();
    const res = await api.put(`/api/items/${orig._id}`, { ...base(), name: before.name, ...patch() });
    expect(res.status).not.toBe(500);
    const after = await Item().findById(orig._id).lean();
    if (expectation === "reject") {
      expect(REJECT).toContain(res.status);
      if (field === "custom_fields") {
        expect(await cfValue(orig._id, ids.cfReq)).toBe("Acme");
        expect(await cfValue(orig._id, ids.cfNum)).toBeUndefined();
      } else {
        for (const k of Object.keys(patch())) expect(after[k]).toEqual(before[k]);
      }
    } else {
      expectation(res, after);
    }
  });
});

describe("Negative: auth, ids, protected fields", () => {
  test("no token → 401", async () => {
    expect((await client(null).get("/api/items")).status).toBe(401);
    expect((await client(null).post("/api/items", { name: "x" })).status).toBe(401);
  });

  test("bad / wrong-secret token → 401", async () => {
    expect((await client("not-a-jwt").get("/api/items")).status).toBe(401);
    const forged = jwt.sign({ id: String(A.admin.id), role: "staff" }, "wrong-secret");
    expect((await client(forged).get("/api/items")).status).toBe(401);
  });

  test("PUT /api/items/abc → 400/404, not 500", async () => {
    const r = await api.put("/api/items/abc", { name: "x" });
    expect([400, 404]).toContain(r.status);
  });

  test("DELETE /api/items/abc → 400/404, not 500", async () => {
    const r = await api.del("/api/items/abc");
    expect([400, 404]).toContain(r.status);
  });

  test("GET /api/items/:id for a missing id → 404, not a crash", async () => {
    const r = await api.get(`/api/items/${new mongoose.Types.ObjectId()}`);
    expect(r.status).toBe(404);
  });

  test("POST body tenant_id / _id / createdAt are ignored", async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const r = await api.post("/api/items", { ...base(), tenant_id: String(B.tenantId), _id: String(fakeId), createdAt: "2000-01-01T00:00:00.000Z" });
    expect(r.status).toBe(201);
    const d = await Item().findById(r.body._id).lean();
    expect({
      tenantIgnored: String(d.tenant_id) === String(A.tenantId),
      idIgnored: String(d._id) !== String(fakeId),
      createdAtIgnored: new Date(d.createdAt).getFullYear() !== 2000,
    }).toEqual({ tenantIgnored: true, idIgnored: true, createdAtIgnored: true });
  });

  test("PUT body tenant_id is ignored (item must not move to another company)", async () => {
    const id = (await api.post("/api/items", base())).body._id;
    const r = await api.put(`/api/items/${id}`, { name: "Moved?", tenant_id: String(B.tenantId) });
    expect(r.status).toBeLessThan(500);
    const d = await Item().findById(id).lean();
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });

  test("PUT body _id / createdAt are ignored (200, unchanged)", async () => {
    const id = (await api.post("/api/items", base())).body._id;
    const before = await Item().findById(id).lean();
    const r = await api.put(`/api/items/${id}`, { name: before.name, _id: String(new mongoose.Types.ObjectId()), createdAt: "2000-01-01T00:00:00.000Z" });
    expect(r.status).toBe(200);
    const d = await Item().findById(id).lean();
    expect(d).not.toBeNull();
    expect(new Date(d.createdAt).getTime()).toBe(new Date(before.createdAt).getTime());
  });
});

describe("Negative: import", () => {
  test("empty array / empty body → 400", async () => {
    expect((await api.post("/api/items/import", [])).status).toBe(400);
    expect((await api.post("/api/items/import", {})).status).toBe(400);
  });

  test("no Name / Item Name / Description column → 400", async () => {
    const r = await api.post("/api/items/import", [{ Rate: 10, Unit: "Nos" }, { Price: 5 }]);
    expect(r.status).toBe(400);
  });

  test("text in Quantity / Rate → row rejected, not saved as quantity 0 / rate 0", async () => {
    const r = await api.post("/api/items/import", [{ "Item Name": "Text qty", Quantity: "abc", Rate: "abc" }]);
    const d = await Item().findOne({ name: "Text qty" }).lean();
    expect(d).toBeNull();
    expect(r.status).not.toBe(500);
  });

  test("mixed file: good rows imported, bad rows reported with reasons", async () => {
    const r = await api.post("/api/items/import", [{ "Item Name": "Mixed ok", Rate: 5 }, { "Item Name": "Mixed bad", Rate: "abc" }]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 1, invalid: 1 });
    expect(r.body.errors[0]).toMatchObject({ row: 2, name: "Mixed bad" });
    expect(r.body.errors[0].reasons.join(" ")).toMatch(/Rate must be a number/);
  });

  test("negative numbers → row rejected", async () => {
    await api.post("/api/items/import", [{ "Item Name": "Neg import", Quantity: -3, Rate: -100, "Cess Rate": -1 }]);
    expect(await Item().findOne({ name: "Neg import" }).lean()).toBeNull();
  });

  test("duplicate names inside one file → imported once", async () => {
    const r = await api.post("/api/items/import", [{ "Item Name": "File dup" }, { "Item Name": "File dup" }, { "Item Name": "file DUP" }]);
    expect(r.status).toBeLessThan(500);
    expect(await Item().countDocuments({ name: /^file dup$/i })).toBe(1);
  });

  test("same file twice → second import adds nothing", async () => {
    const rows = [{ "Item Name": "Twice 1" }, { "Item Name": "Twice 2" }, { "Item Name": "Twice 3" }];
    expect((await api.post("/api/items/import", rows)).body.count).toBe(3);
    const r2 = await api.post("/api/items/import", rows);
    expect(r2.body).toMatchObject({ count: 0, skipped: 3 });
    expect(await Item().countDocuments({ name: /^Twice / })).toBe(3);
  });

  test("very large file (5000 rows) imports without error", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ "Item Name": `Bulk ${i}`, Rate: i }));
    const r = await api.post("/api/items/import", rows);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(5000);
  });

  test("import row with tenant_id / _id columns cannot write into another tenant", async () => {
    await api.post("/api/items/import", [{ "Item Name": "Row tenant", tenant_id: String(B.tenantId), _id: String(new mongoose.Types.ObjectId()) }]);
    const d = await Item().findOne({ name: "Row tenant" }).lean();
    expect(String(d.tenant_id)).toBe(String(A.tenantId));
  });
});

describe("Negative: bulk delete, double submit, delete in-use item", () => {
  test("bulk delete with nothing selected → 400", async () => {
    expect((await api.post("/api/items/bulk-delete", { ids: [] })).status).toBe(400);
    expect((await api.post("/api/items/bulk-delete", {})).status).toBe(400);
  });

  test("bulk delete with an invalid id → 400, not 500", async () => {
    const r = await api.post("/api/items/bulk-delete", { ids: ["abc"] });
    expect(r.status).toBe(400);
  });

  test("double-submit (2 identical POSTs at once) → one item", async () => {
    const body = { ...base(), name: "Double submit" };
    await Promise.all([api.post("/api/items", body), api.post("/api/items", body)]);
    expect(await Item().countDocuments({ name: "Double submit" })).toBe(1);
  });

  test("deleting an item used on an invoice: old invoice line stays intact", async () => {
    const clientId = (await db.collection("clients").insertOne({ company: "C", tenant_id: A.tenantId })).insertedId;
    const it = (await api.post("/api/items", { ...base(), name: "Used item", rate: 250, unit: "Kg", hsn_sac_code: "1006" })).body;
    const inv = await api.post("/api/invoices", {
      client: String(clientId), number: "INV-NEG-1",
      items: [{ description: it.name, qty: 2, rate: it.rate, unit: it.unit, itemHSN: it.hsn_sac_code, amount: 500 }],
    });
    expect(inv.status).toBe(201);
    const del = await api.del(`/api/items/${it._id}`);
    expect(del.status).toBeLessThan(500);
    const saved = await db.collection("invoices").findOne({ number: "INV-NEG-1" });
    expect(saved.items[0]).toMatchObject({ description: "Used item", qty: 2, rate: 250, unit: "Kg", itemHSN: "1006" });
  });
});
