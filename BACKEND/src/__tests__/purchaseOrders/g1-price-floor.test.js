// G1 — "Price only up" (PoSettings.rules.<type>.price_floor): below the list
// price is refused (400) on create / edit / submit; a raise above it needs an
// approver ("Price raised from <list> to <selling>"); at list = no approval.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const rules = require("../../services/purchaseOrderRules");

jest.setTimeout(240000);
const P = S.PO_PATH;
const SET = `${P}/settings`;
let A, B;
const PoItem = () => require("../../models/PoItem");
const PoSettings = () => require("../../models/PoSettings");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ctrl = () => require("../../controllers/purchase_order_controller");

const SALES_FLOOR = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false, price_floor: true };
const SALES_NO_FLOOR = { ...SALES_FLOOR, price_floor: false };
// Round 28 (R6): the Purchase PO default — floor on, End User Price.
const PURCHASE = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: 13, allow_below_list: false, price_floor: true };
const L = (selling, list = 160, cost = 100) => ({ name: "I1", qty: 1, cost_price: cost, list_price: list, selling_price: selling, tax_rate: 18 });
const verdict = (selling, rule, list = 160, type = "sales") => {
  const line = rules.computeLine(L(selling, list), type);
  return { floor: rules.floorError(line, rule), breaches: rules.lineBreaches(line, rule) };
};
// Round 28 (R1/R6): the customer's selling price + floor are on the Purchase
// PO (Sales PO was removed); the helper keeps its name.
const sales = (items, extra = {}) => ({ type: "purchase", division: "brady", customer: String(A.customers.c1._id), items, ...extra });
const MARGIN_I1 = "Line 1 (I1 Label A): Margin 6.25% is below the 13% minimum"; // MDP 150 at 160
const i1 = (selling, extra = {}) => S.line(A.items.I1, 1, { selling_price: selling, ...extra });
const FLOOR_MSG = "Line 1 (I1 Label A): price can't be lower than the price-master price 160";

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] G1", JSON.stringify(S.guardReport()));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("G1 UNIT — floor rule (same verdicts / texts as poCalc.ts, see poCalcFloor.test.ts)", () => {
  test("selling = list -> fine, no approval", () => {
    expect(verdict(160, SALES_FLOOR)).toEqual({ floor: null, breaches: [] });
  });
  test("list + 0.01 -> raised, needs approval", () => {
    expect(verdict(160.01, SALES_FLOOR)).toEqual({ floor: null, breaches: ["Price raised from 160 to 160.01"] });
  });
  test("list - 0.01 and 0 -> refused (floor error), no breach", () => {
    expect(verdict(159.99, SALES_FLOOR)).toEqual({ floor: "price can't be lower than the price-master price 160", breaches: [] });
    expect(verdict(0, SALES_FLOOR).floor).toBe("price can't be lower than the price-master price 160");
  });
  test("list price 0 -> not checked either way", () => {
    expect(verdict(1, SALES_FLOOR, 0)).toEqual({ floor: null, breaches: [] });
    expect(verdict(999, SALES_FLOOR, 0)).toEqual({ floor: null, breaches: [] });
  });
  test("floor off -> old behaviour (below list = approval, raise = free)", () => {
    expect(verdict(159.99, SALES_NO_FLOOR)).toEqual({ floor: null, breaches: ["Price 159.99 is below the list price 160"] });
    expect(verdict(175, SALES_NO_FLOOR)).toEqual({ floor: null, breaches: [] });
  });
  test("purchase PO with the R6 default (floor on) -> below list is an error", () => {
    expect(verdict(150, PURCHASE, 160, "purchase").floor).toBe("price can't be lower than the price-master price 160");
  });
  test("raise + other rules: margin / discount rules still apply on top", () => {
    const rule = { ...SALES_FLOOR, min_margin_pct: 50 };
    expect(verdict(170, rule).breaches).toEqual(["Margin 41.18% is below the 50% minimum", "Price raised from 160 to 170"]);
  });
  test("evaluatePo: reasons carry the line number and item name", () => {
    const r = rules.evaluatePo({ lines: [L(160), L(175)], type: "sales", taxMode: "intra", rule: SALES_FLOOR });
    expect(r.approvalRequired).toBe(true);
    expect(r.reasons).toEqual(["Line 2 (I1): Price raised from 160 to 175"]);
  });
  test("cleanRule price_floor: true / false / 'true' / 'false' / missing (keeps saved) / bad value", () => {
    const { cleanRule } = ctrl();
    const base = { list_price_field: "end_customer_price" };
    expect(cleanRule({ ...base, price_floor: true }, "Sales PO").price_floor).toBe(true);
    expect(cleanRule({ ...base, price_floor: false }, "Sales PO", { price_floor: true }).price_floor).toBe(false);
    expect(cleanRule({ ...base, price_floor: "false" }, "Sales PO", { price_floor: true }).price_floor).toBe(false);
    expect(cleanRule({ ...base, price_floor: "true" }, "Sales PO").price_floor).toBe(true);
    expect(cleanRule(base, "Sales PO", { price_floor: true }).price_floor).toBe(true);
    expect(cleanRule(base, "Purchase PO", { price_floor: false }).price_floor).toBe(false);
    expect(cleanRule({ ...base, price_floor: null }, "Sales PO", { price_floor: true }).price_floor).toBe(true);
    for (const bad of ["abc", 1, 0, {}, []]) {
      expect(() => cleanRule({ ...base, price_floor: bad }, "Sales PO")).toThrow('Sales PO: "Price can only go up" must be on or off');
    }
  });
  test("PoSettings defaults: sales on, purchase ON since R6 (DEFAULT_PO_SETTINGS and schema agree)", () => {
    const { DEFAULT_PO_SETTINGS } = PoSettings();
    expect(DEFAULT_PO_SETTINGS.rules.sales.price_floor).toBe(true);
    expect(DEFAULT_PO_SETTINGS.rules.purchase.price_floor).toBe(true);
    const doc = new (PoSettings())({ tenant_id: new mongoose.Types.ObjectId() });
    expect(doc.rules.sales.price_floor).toBe(true);
    expect(doc.rules.purchase.price_floor).toBe(true);
  });
});

describe("G1 POSITIVE", () => {
  // R4: at list the PO still waits for a Yes; nothing about the price is
  // pointed out (only I1's low margin at MDP 150).
  test("I1 at 160 (= master) -> Submit -> pending, no 'raised' reason", async () => {
    const r = await A.users.maker.api.post(P, sales([i1(160)], { submit: true }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "pending_approval", approval: { required: true, reasons: [MARGIN_I1] } });
  });
  test("selling price left out -> list price, pending", async () => {
    const r = await A.users.maker.api.post(P, sales([S.line(A.items.I1, 2)], { submit: true }));
    expect(r.body.items[0].selling_price).toBe(160);
    expect(r.body.status).toBe("pending_approval");
  });
  test("I1 raised to 175 -> pending, approver gets the socket event, Yes -> approved", async () => {
    const n = S.rec.io.length;
    const r = await A.users.maker.api.post(P, sales([i1(175)], { submit: true }));
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.reasons).toEqual(["Line 1 (I1 Label A): Price raised from 160 to 175"]);
    const rooms = S.rec.io.slice(n).filter((e) => e.event === "purchaseOrderApproval").map((e) => e.room);
    expect(rooms).toContain(String(A.users.approver.id));
    expect(rooms).not.toContain(String(A.users.maker.id));
    const y = await A.users.approver.api.post(`${P}/${r.body._id}/approve`, {});
    expect(y.body.status).toBe("approved");
    expect(y.body.items[0]).toMatchObject({ selling_price: 175, rate: 150 }); // the PO to Brady prints the cost
  });
  test("[REVERSED R4/Q7] an approver's own raised-price PO is NOT auto-approved on submit", async () => {
    const r = await A.users.admin.api.post(P, sales([i1(180)], { submit: true }));
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.decision).toBeUndefined();
  });
  test("I3 has no list price -> any price passes the floor (no floor error, no 'raised' reason)", async () => {
    const r = await A.users.maker.api.post(P, sales([S.line(A.items.I3, 1, { selling_price: 1 })], { submit: true }));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.reasons.join(" ")).not.toMatch(/raised|lower than/);
  });
  test("[REVERSED R6] Purchase PO: a customer price below the End User Price is refused", async () => {
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [i1(150)] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(FLOOR_MSG);
  });
});

describe("G1 NEGATIVE", () => {
  test.each([[159.99], [100], [0], ["159.99"]])("I1 at %p -> 400 on create; nothing saved", async (price) => {
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    for (const submit of [false, true]) {
      const r = await A.users.maker.api.post(P, sales([i1(price)], { submit }));
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(FLOOR_MSG);
    }
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("edit a draft down to 159.99 / 100 / 0 -> 400; draft unchanged", async () => {
    const d = (await A.users.maker.api.post(P, sales([i1(165)]))).body;
    const before = await PurchaseOrder().findById(d._id).lean();
    for (const price of [159.99, 100, 0]) {
      for (const submit of [false, true]) {
        const r = await A.users.maker.api.put(`${P}/${d._id}`, sales([i1(price)], { submit }));
        expect(r.status).toBe(400);
        expect(r.body.message).toBe(FLOOR_MSG);
      }
    }
    expect(await PurchaseOrder().findById(d._id).lean()).toEqual(before);
  });
  test("master raised to 170 after a draft was saved at 165 -> submit 400 until the line is raised to >= 170", async () => {
    const it = (await A.users.pricer.api.post(`${P}/items`, { name: "Moving Floor", item_code: "MF-1", category: "G1", cost_price: 100, end_customer_price: 160 } /* r29: series required */)).body;
    const d = (await A.users.maker.api.post(P, sales([S.line(it, 1, { selling_price: 165 })]))).body;
    expect(d.status).toBe("draft");
    await A.users.pricer.api.put(`${P}/items/${it._id}`, { end_customer_price: 170 });
    const s1 = await A.users.maker.api.post(`${P}/${d._id}/submit`, {});
    expect(s1.status).toBe(400);
    expect(s1.body.message).toBe("Line 1 (Moving Floor): price can't be lower than the price-master price 170");
    expect((await PurchaseOrder().findById(d._id).lean()).status).toBe("draft");
    // raising it to 169.99 is still too low; to 170 passes and needs no approval
    expect((await A.users.maker.api.put(`${P}/${d._id}`, sales([S.line(it, 1, { selling_price: 169.99 })]))).status).toBe(400);
    expect((await A.users.maker.api.put(`${P}/${d._id}`, sales([S.line(it, 1, { selling_price: 170 })]))).status).toBe(200);
    const s2 = await A.users.maker.api.post(`${P}/${d._id}/submit`, {});
    expect(s2.body).toMatchObject({ status: "pending_approval", approval: { reasons: [] } }); // R4
    expect(s2.body.items[0]).toMatchObject({ list_price: 170, selling_price: 170 });
  });
  test("cost_price / list_price in the body can't dodge the floor (the master is used)", async () => {
    const r = await A.users.maker.api.post(P, sales([i1(120, { list_price: 100, cost_price: 50, end_customer_price: 100 })]));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(FLOOR_MSG);
    const ok = await A.users.maker.api.post(P, sales([i1(160, { list_price: 999, cost_price: 1 })]));
    expect(ok.body.items[0]).toMatchObject({ list_price: 160, cost_price: 150 });
    expect(ok.body.approval.reasons).toEqual([MARGIN_I1]); // no "raised" — the posted list price was ignored
  });
  test("two lines: the second one below list -> 400 'Line 2 (...)'", async () => {
    const r = await A.users.maker.api.post(P, sales([i1(160), S.line(A.items.I5, 1, { selling_price: 69 })]));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 2 (I5 Brady A): price can't be lower than the price-master price 70");
  });
  test("non-admin PUT of price_floor -> 403; settings unchanged", async () => {
    const before = (await A.users.admin.api.get(SET)).body.rules;
    for (const u of ["maker", "approver", "pricer", "viewer"]) {
      const r = await A.users[u].api.put(SET, { rules: { sales: { ...before.sales, price_floor: false } } });
      expect(r.status).toBe(403);
    }
    expect((await A.users.admin.api.get(SET)).body.rules).toEqual(before);
  });
  test("price_floor 'abc' -> 400", async () => {
    const cur = (await A.users.admin.api.get(SET)).body.rules;
    const r = await A.users.admin.api.put(SET, { rules: { sales: { ...cur.sales, price_floor: "abc" } } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Sales PO: "Price can only go up" must be on or off');
  });
});

describe("G1 INTEGRATION", () => {
  test("an old settings document without price_floor reads the schema default (sales on, purchase ON since R6) — no DB write needed", async () => {
    const E = await S.seedTenant("E", { settings: false }); // its settings are inserted raw below
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${E.tenantId}`;
    const { DEFAULT_PO_SETTINGS, DEFAULT_FORMAT } = PoSettings();
    const legacyRules = {
      purchase: { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true },
      sales: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false },
    };
    await mongoose.connection.db.collection("posettings").insertOne({
      tenant_id: E.tenantId, divisions: DEFAULT_PO_SETTINGS.divisions, counters: {}, rules: legacyRules,
      supplier: { name: "Brady" }, whatsapp: {}, format: DEFAULT_FORMAT, format_version: 1,
      format_history: [{ version: 1, format: DEFAULT_FORMAT, saved_at: new Date() }],
    });
    const r = await E.users.viewer.api.get(SET);
    expect(r.body.rules.sales.price_floor).toBe(true);
    expect(r.body.rules.purchase.price_floor).toBe(true);
    // the stored document was not rewritten
    const raw = await mongoose.connection.db.collection("posettings").findOne({ tenant_id: E.tenantId });
    expect(raw.rules).toEqual(legacyRules);
    // and the floor is enforced for that company (on the Purchase PO, R6)
    const below = await E.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(E.customers.c1._id), items: [S.line(E.items.I1, 1, { selling_price: 150 })] });
    expect(below.status).toBe(400);
  });

  // R6 (round 28): "never below the End User Price" is a fixed rule of the
  // Purchase PO — the old PO Settings switch can't turn it off any more.
  test("[REVERSED R6] switching price_floor off in PO Settings does NOT unblock below-list prices on a Purchase PO", async () => {
    const cur = (await A.users.admin.api.get(SET)).body.rules;
    const off = await A.users.admin.api.put(SET, { rules: { purchase: { ...cur.purchase, price_floor: false }, sales: { ...cur.sales, price_floor: false } } });
    expect(off.status).toBe(200);
    const p1 = await A.users.maker.api.post(P, sales([i1(150)], { submit: true }));
    expect(p1.status).toBe(400);
    expect(p1.body.message).toBe(FLOOR_MSG);
    // a raise still goes to the approver with the reason
    const up = await A.users.maker.api.post(P, sales([i1(175)], { submit: true }));
    expect(up.body.status).toBe("pending_approval");
    expect(up.body.approval.reasons).toEqual(["Line 1 (I1 Label A): Price raised from 160 to 175"]);
    expect(up.body.rule_snapshot.price_floor).toBe(true);
    await A.users.admin.api.put(SET, { rules: { purchase: cur.purchase, sales: cur.sales } });
  });

  test("an approved PO keeps its prices and rule snapshot after the master price changes", async () => {
    const it = (await A.users.pricer.api.post(`${P}/items`, { name: "Snapshot Item", item_code: "SNAP-1", category: "G1", cost_price: 50, end_customer_price: 80 } /* r29: catalog + series required */)).body;
    const pend = (await A.users.maker.api.post(P, sales([S.line(it, 2)], { submit: true }))).body;
    const appr = (await A.users.approver.api.post(`${P}/${pend._id}/approve`, {})).body; // R4
    expect(appr.status).toBe("approved");
    await A.users.pricer.api.put(`${P}/items/${it._id}`, { end_customer_price: 95, cost_price: 60 });
    const g = (await A.users.maker.api.get(`${P}/${appr._id}`)).body;
    expect(g.items[0]).toMatchObject({ list_price: 80, cost_price: 50, selling_price: 80 });
    expect(g.rule_snapshot).toMatchObject({ price_floor: true, list_price_field: "end_customer_price" });
    expect(g.totals.subtotal).toBe(100); // 2 x cost 50 (the PO to Brady is at cost)
  });

  test("lowering the price is impossible end to end: API 400, DB unchanged, nothing logged", async () => {
    const d = (await A.users.maker.api.post(P, sales([i1(170)]))).body;
    const before = await PurchaseOrder().findById(d._id).lean();
    const count = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    expect((await A.users.maker.api.put(`${P}/${d._id}`, sales([i1(159)], { submit: true }))).status).toBe(400);
    expect((await A.users.maker.api.post(P, sales([i1(1)], { submit: true }))).status).toBe(400);
    expect((await A.users.admin.api.post(P, sales([i1(1)], { submit: true }))).status).toBe(400); // approvers too
    expect(await PurchaseOrder().findById(d._id).lean()).toEqual(before);
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(count);
  });

  test("company separation: B's floor setting is independent of A's (and the Purchase PO floor holds in both, R6)", async () => {
    const curB = (await B.users.admin.api.get(SET)).body.rules;
    await B.users.admin.api.put(SET, { rules: { sales: { ...curB.sales, price_floor: false } } });
    expect((await A.users.admin.api.get(SET)).body.rules.sales.price_floor).toBe(true);
    expect((await B.users.admin.api.get(SET)).body.rules.sales.price_floor).toBe(false);
    expect((await A.users.maker.api.post(P, sales([i1(150)]))).status).toBe(400);
    const bBelow = await B.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(B.customers.c1._id), items: [S.line(B.items.I1, 1, { selling_price: 150 })] });
    expect(bBelow.status).toBe(400);
  });

  test("View (Own) maker gets the same floor", async () => {
    const r = await A.users.own.api.post(P, sales([i1(100)]));
    expect(r.status).toBe(400);
    expect((await A.users.own.api.post(P, sales([i1(200)], { submit: true }))).body.status).toBe("pending_approval");
  });

  test("PoItem with list price but master changed via Excel upload: the floor follows the new master", async () => {
    await A.users.pricer.api.post(`${P}/items/import`, { rows: [{ item_code: "BR-001", end_customer_price: 75 }] });
    const r = await A.users.maker.api.post(P, sales([S.line(A.items.I5, 1, { selling_price: 72 })]));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1 (I5 Brady A): price can't be lower than the price-master price 75");
    expect((await PoItem().findById(A.items.I5._id).lean()).end_customer_price).toBe(75);
  });
});
