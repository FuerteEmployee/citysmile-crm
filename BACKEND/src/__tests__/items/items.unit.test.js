// Items — UNIT tests: Item model + item_controller functions called directly
// (fake req/res) on an in-memory MongoDB. Each test states the CORRECT
// behaviour; a failing test is a bug found. See src/testUtils/crmTestApp.js.
const mongoose = require("mongoose");
const { start, stop } = require("../../testUtils/crmTestApp");

jest.setTimeout(120000);

let Item;
let Tax;
let ctrl;
const tenantA = new mongoose.Types.ObjectId();
const tenantB = new mongoose.Types.ObjectId();

const fakeRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const call = async (fn, { body = {}, params = {}, query = {}, user = { tenant_id: tenantA } } = {}) => {
  const res = fakeRes();
  await fn({ body, params, query, user }, res);
  return res;
};

beforeAll(async () => {
  await start([]); // DB only, no routes
  Item = require("../../models/Item");
  Tax = require("../../models/Tax");
  require("../../models/CustomField");
  require("../../models/CustomFieldValue");
  ctrl = require("../../controllers/item_controller");
});
afterAll(stop);
beforeEach(async () => { await Item.deleteMany({}); });

describe("Unit: Item model", () => {
  test("name is required", () => {
    const err = new Item({}).validateSync();
    expect(err?.errors?.name).toBeDefined();
  });

  test("spaces-only name is rejected (trim + required)", () => {
    const err = new Item({ name: "   " }).validateSync();
    expect(err?.errors?.name).toBeDefined();
  });

  test("defaults: quantity 1, rate 0, amount 0, cess 0, tax_inclusive false, branch ''", () => {
    const it = new Item({ name: "X" });
    expect(it.quantity).toBe(1);
    expect(it.rate).toBe(0);
    expect(it.amount).toBe(0);
    expect(it.cess_rate).toBe(0);
    expect(it.tax_inclusive).toBe(false);
    expect(it.branch).toBe("");
  });

  test("number fields cast numeric strings and reject non-numeric text", () => {
    const ok = new Item({ name: "X", quantity: "2", rate: "10.5", amount: "21", cess_rate: "1" });
    expect(ok.validateSync()).toBeUndefined();
    expect([ok.quantity, ok.rate, ok.amount, ok.cess_rate]).toEqual([2, 10.5, 21, 1]);
    const bad = new Item({ name: "X", quantity: "abc", rate: "abc", amount: "abc", cess_rate: "abc" });
    const err = bad.validateSync();
    for (const f of ["quantity", "rate", "amount", "cess_rate"]) expect(err.errors[f]).toBeDefined();
  });

  test("tax and tax2 reference the Tax model", () => {
    expect(Item.schema.path("tax").options.ref).toBe("Tax");
    expect(Item.schema.path("tax2").options.ref).toBe("Tax");
  });

  // Enforced in the controller rather than the model: a required tenant_id on the
  // model would break saving legacy items that have none (see createItem test below).
  test("tenant_id is always set: a user without a company cannot create items", async () => {
    const before = await Item.countDocuments({});
    const r = await call(ctrl.createItem, { body: { name: "Orphan" }, user: {} });
    expect([400, 403]).toContain(r.statusCode);
    expect(await Item.countDocuments({})).toBe(before);
  });

  test.each([
    ["quantity", -5], ["rate", -100], ["amount", -1], ["cess_rate", -1],
  ])("negative %s is rejected by the model", (field, v) => {
    const err = new Item({ name: "X", tenant_id: tenantA, [field]: v }).validateSync();
    expect(err?.errors?.[field]).toBeDefined();
  });

  test("cess_rate above 100 is rejected by the model", () => {
    const err = new Item({ name: "X", tenant_id: tenantA, cess_rate: 101 }).validateSync();
    expect(err?.errors?.cess_rate).toBeDefined();
  });
});

describe("Unit: item_controller", () => {
  test("createItem sets tenant_id from the user, not from the body", async () => {
    const r = await call(ctrl.createItem, { body: { name: "Pen", tenant_id: String(tenantB) } });
    expect(r.statusCode).toBe(201);
    const db = await Item.findById(r.body._id).lean();
    expect(String(db.tenant_id)).toBe(String(tenantA));
  });

  test("createItem uses description as the name when name is missing", async () => {
    const r = await call(ctrl.createItem, { body: { description: "From description" } });
    expect(r.statusCode).toBe(201);
    expect(r.body.name).toBe("From description");
  });

  test("createItem without a name returns 400 (validation), not 500", async () => {
    const r = await call(ctrl.createItem, { body: { rate: 5 } });
    expect(r.statusCode).toBe(400);
  });

  test("updateItem changes fields and returns the updated item", async () => {
    const it = await Item.create({ name: "Old", rate: 1, tenant_id: tenantA });
    const r = await call(ctrl.updateItem, { params: { id: String(it._id) }, body: { name: "New", rate: 9 } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ name: "New", rate: 9 });
  });

  test("updateItem / deleteItem on a missing id return 404", async () => {
    const id = String(new mongoose.Types.ObjectId());
    expect((await call(ctrl.updateItem, { params: { id }, body: { name: "x" } })).statusCode).toBe(404);
    expect((await call(ctrl.deleteItem, { params: { id } })).statusCode).toBe(404);
  });

  test("updateItem / deleteItem refuse another tenant's item (404)", async () => {
    const b = await Item.create({ name: "B item", tenant_id: tenantB });
    const u = await call(ctrl.updateItem, { params: { id: String(b._id) }, body: { name: "hacked" } });
    expect(u.statusCode).toBe(404);
    const d = await call(ctrl.deleteItem, { params: { id: String(b._id) } });
    expect(d.statusCode).toBe(404);
    const db = await Item.findById(b._id).lean();
    expect(db?.name).toBe("B item");
  });

  test("deleteItem removes the item", async () => {
    const it = await Item.create({ name: "Del", tenant_id: tenantA });
    const r = await call(ctrl.deleteItem, { params: { id: String(it._id) } });
    expect(r.statusCode).toBe(200);
    expect(await Item.findById(it._id)).toBeNull();
  });

  describe("getItems list", () => {
    beforeEach(async () => {
      const docs = [];
      for (let i = 1; i <= 30; i++) {
        docs.push({ name: `Item ${String(i).padStart(2, "0")}`, branch: i % 2 ? "Mumbai" : "Pune", group: i === 7 ? "Special" : "", hsn_sac_code: i === 8 ? "998877" : "", tenant_id: tenantA });
      }
      docs.push({ name: "Other tenant", tenant_id: tenantB, branch: "Mumbai" });
      await Item.insertMany(docs);
    });

    test("no query → bare array of own tenant only", async () => {
      const r = await call(ctrl.getItems);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body).toHaveLength(30);
    });

    test("page/limit paginate; limit clamps to 500, page < 1 → 1", async () => {
      const r = await call(ctrl.getItems, { query: { page: "2", limit: "10" } });
      expect(r.body).toMatchObject({ total: 30, page: 2, pages: 3, limit: 10 });
      expect(r.body.data).toHaveLength(10);
      const big = await call(ctrl.getItems, { query: { page: "0", limit: "9999" } });
      expect(big.body).toMatchObject({ page: 1, limit: 500 });
    });

    test("search matches name, group, hsn, branch (case-insensitive)", async () => {
      expect((await call(ctrl.getItems, { query: { search: "item 0" } })).body.total).toBe(9);
      expect((await call(ctrl.getItems, { query: { search: "special" } })).body.total).toBe(1);
      expect((await call(ctrl.getItems, { query: { search: "998877" } })).body.total).toBe(1);
      expect((await call(ctrl.getItems, { query: { search: "pune" } })).body.total).toBe(15);
    });

    test("regex characters in search are escaped (no 500)", async () => {
      const r = await call(ctrl.getItems, { query: { search: "(.*[" } });
      expect(r.statusCode).toBe(200);
      expect(r.body.total).toBe(0);
    });

    test("branch filter", async () => {
      const r = await call(ctrl.getItems, { query: { branch: "Mumbai", limit: "100" } });
      expect(r.body.total).toBe(15);
    });
  });

  describe("importItems counts", () => {
    test("valid / duplicate-of-existing / invalid rows → count 1, skipped 1, invalid ignored", async () => {
      await Item.create({ name: "Existing", tenant_id: tenantA });
      const r = await call(ctrl.importItems, {
        body: [{ "Item Name": "Brand new", Rate: "10" }, { "Item Name": "existing" }, { Foo: "no name" }],
      });
      expect(r.statusCode).toBe(201);
      expect(r.body).toMatchObject({ count: 1, skipped: 1 });
    });

    test("the same name twice in one file is imported once", async () => {
      const r = await call(ctrl.importItems, { body: [{ "Item Name": "Twice" }, { "Item Name": "Twice" }] });
      expect(await Item.countDocuments({ name: "Twice" })).toBe(1);
      expect(r.body.skipped).toBe(1);
    });

    test("no row with a name → 400", async () => {
      const r = await call(ctrl.importItems, { body: [{ Rate: 5 }] });
      expect(r.statusCode).toBe(400);
    });

    test("duplicate check is case-insensitive against existing items", async () => {
      await Item.create({ name: "Laptop Stand", tenant_id: tenantA });
      const r = await call(ctrl.importItems, { body: [{ "Item Name": "LAPTOP STAND" }] });
      expect(r.body.count).toBe(0);
      expect(await Item.countDocuments({ tenant_id: tenantA })).toBe(1);
    });
  });

  describe("bulkDeleteItems", () => {
    test("empty / missing ids → 400", async () => {
      expect((await call(ctrl.bulkDeleteItems, { body: { ids: [] } })).statusCode).toBe(400);
      expect((await call(ctrl.bulkDeleteItems, { body: {} })).statusCode).toBe(400);
    });

    test("deletes only own tenant's ids", async () => {
      const a = await Item.create({ name: "a", tenant_id: tenantA });
      const b = await Item.create({ name: "b", tenant_id: tenantB });
      const r = await call(ctrl.bulkDeleteItems, { body: { ids: [String(a._id), String(b._id)] } });
      expect(r.body.count).toBe(1);
      expect(await Item.findById(b._id)).not.toBeNull();
    });

    test("an invalid id in the list → 400, not 500", async () => {
      const r = await call(ctrl.bulkDeleteItems, { body: { ids: ["abc"] } });
      expect(r.statusCode).toBe(400);
    });
  });

  test("Tax search lookup in getItems is limited to the user's tenant", async () => {
    // A tax named like Tenant B's tax should not be needed to search A's items;
    // the lookup itself (Tax.find({name})) should be tenant scoped.
    const spy = jest.spyOn(Tax, "find");
    await call(ctrl.getItems, { query: { search: "GST" } });
    const filter = spy.mock.calls[0][0];
    spy.mockRestore();
    expect(filter.tenant_id).toBeDefined();
  });
});
