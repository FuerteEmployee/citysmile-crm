// PART 2 — Create / Edit PO + pricing maths (POST /, GET/PUT /:id, rules maths).
// "[BUG]" / "[RECORD]" tests assert the CURRENT behaviour; the name says what is wrong.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const rules = require("../../services/purchaseOrderRules");

jest.setTimeout(180000);
const P = S.PO_PATH;
const year = new Date().getFullYear();
const fy = S.fyNow();
let A, B;
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const PoSettings = () => require("../../models/PoSettings");

// ── Reference port of CRM-FRONTEND-NEW/src/pages/purchase-orders/poCalc.ts ──
// (verbatim formulas; TS types removed). Used to prove backend == frontend maths.
const fe = (() => {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const marginPct = (selling, cost) => (selling > 0 && cost > 0 ? round2(((selling - cost) / selling) * 100) : null);
  const marginAmount = (selling, cost, qty) => (cost > 0 ? round2((selling - cost) * qty) : null);
  const discountPct = (selling, list) => (list > 0 ? round2(((list - selling) / list) * 100) : 0);
  const breachesFor = (l, rule) => {
    const out = [];
    if (rule.min_margin_pct !== null && rule.min_margin_pct !== undefined) {
      if (!(l.cost_price > 0)) out.push("Cost price not set");
      else if (l.margin_pct === null || l.margin_pct < rule.min_margin_pct) out.push(`Margin below ${rule.min_margin_pct}%`);
    }
    if (rule.max_discount_pct !== null && rule.max_discount_pct !== undefined && l.list_price > 0 && l.discount_pct > rule.max_discount_pct) {
      out.push(`Discount above ${rule.max_discount_pct}%`);
    }
    // G1 mirror of poCalc.ts: price only up -> a raise needs approval
    if (rule.price_floor) {
      if (l.list_price > 0 && l.selling_price > l.list_price) out.push(`Price raised from ${l.list_price} to ${l.selling_price}`);
    } else if (rule.allow_below_list === false && l.list_price > 0 && l.selling_price < l.list_price) out.push("Below list price");
    if (l.cost_source === "dp") out.push("Cost from DP (no Master Distributor Price)");
    return out;
  };
  const computePo = (lines, type, taxMode, rule) => {
    const computed = lines.map((raw) => {
      const qty = Math.max(Number(raw.qty) || 0, 0);
      const cost = Number(raw.cost_price) || 0;
      const list = Number(raw.list_price) || 0;
      const selling = Number(raw.selling_price) || 0;
      const taxRate = Math.max(Number(raw.tax_rate) || 0, 0);
      // Q3: the PO to Brady prints whole-rupee rates.
      const rate = type === "purchase" ? Math.round(cost) : selling;
      const amount = round2(qty * rate);
      const base = { ...raw, qty, cost_price: cost, list_price: list, selling_price: selling, tax_rate: taxRate, rate, amount, tax_amount: round2((amount * taxRate) / 100), discount_pct: discountPct(selling, list), margin_pct: marginPct(selling, cost), margin_amount: marginAmount(selling, cost, qty) };
      return { ...base, breaches: rule ? breachesFor(base, rule) : [] };
    });
    const subtotal = round2(computed.reduce((s, l) => s + l.amount, 0));
    const taxTotal = round2(computed.reduce((s, l) => s + l.tax_amount, 0));
    const sellValue = round2(computed.reduce((s, l) => s + l.qty * l.selling_price, 0));
    const costValue = round2(computed.reduce((s, l) => s + l.qty * l.cost_price, 0));
    const half = round2(taxTotal / 2);
    const allCosted = costValue > 0 && computed.every((l) => l.cost_price > 0);
    return {
      lines: computed,
      totals: { subtotal, cgst: taxMode === "intra" ? half : 0, sgst: taxMode === "intra" ? round2(taxTotal - half) : 0, igst: taxMode === "inter" ? taxTotal : 0, tax_total: taxTotal, grand_total: round2(subtotal + taxTotal), sell_value: sellValue, cost_value: costValue, margin_pct: allCosted ? marginPct(sellValue, costValue) : null, margin_amount: allCosted ? round2(sellValue - costValue) : null },
      approvalRequired: computed.some((l) => l.breaches.length > 0),
    };
  };
  return { computePo };
})();

const PUR = { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true };
const SAL = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false };
const L = (qty, cost, list, selling, tax = 18) => ({ name: "x", qty, cost_price: cost, list_price: list, selling_price: selling, tax_rate: tax });
const both = (lines, type, mode, rule) => {
  const be = rules.evaluatePo({ lines, type, taxMode: mode, rule });
  const f = fe.computePo(lines, type, mode, rule);
  return { be, f };
};
const pick = (l) => ({ qty: l.qty, rate: l.rate, amount: l.amount, tax_amount: l.tax_amount, discount_pct: l.discount_pct, margin_pct: l.margin_pct, margin_amount: l.margin_amount });

// Pricing table rows (also printed for the report)
const pricingRows = [];

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[pricing-table]\n" + pricingRows.map((r) => JSON.stringify(r)).join("\n"));
  console.log("[guard] PART2", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, wa: S.rec.whatsapp.length, cloud: S.rec.cloudinary.length }));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("2.1 UNIT — pricing formulas (backend purchaseOrderRules.js vs frontend poCalc.ts port)", () => {
  const cases = [
    { name: "I1 purchase in rule", lines: [L(2, 100, 160, 160)], type: "purchase", rule: PUR, exp: { amount: 200, margin: 37.5, discount: 0, verdict: false } },
    { name: "cost 0 (unknown)", lines: [L(1, 0, 200, 200)], type: "purchase", rule: PUR, exp: { amount: 0, margin: null, discount: 0, verdict: true } },
    { name: "list 0 (no list price)", lines: [L(1, 80, 0, 100)], type: "sales", rule: SAL, exp: { amount: 100, margin: 20, discount: 0, verdict: false } },
    { name: "selling 0", lines: [L(1, 80, 100, 0)], type: "sales", rule: SAL, exp: { amount: 0, margin: null, discount: 100, verdict: true } },
    { name: "selling > list", lines: [L(1, 80, 100, 120)], type: "sales", rule: SAL, exp: { amount: 120, margin: 33.33, discount: -20, verdict: false } },
    { name: "qty 0.5", lines: [L(0.5, 100, 160, 160)], type: "purchase", rule: PUR, exp: { amount: 50, margin: 37.5, discount: 0, verdict: false } },
    // Q3 (round 28): the purchase rate is the cost rounded to the rupee (0.1 / 0.2 -> 0).
    { name: "rounding 0.1+0.2 (purchase)", lines: [L(1, 0.1, 0.3, 0.3), L(1, 0.2, 0.3, 0.3)], type: "purchase", rule: PUR, exp: { amount: 0, margin: 66.67, discount: 0, verdict: false } },
    { name: "33.333 x 3", lines: [L(3, 10, 33.333, 33.333)], type: "sales", rule: SAL, exp: { amount: 100, margin: 70, discount: 0, verdict: false } },
    { name: "I6 two taxes 23%", lines: [L(1, 10, 20, 20, 23)], type: "sales", rule: SAL, exp: { amount: 20, margin: 50, discount: 0, verdict: false, tax: 4.6 } },
    { name: "I4 big values", lines: [L(3, 99999.99, 120000, 120000)], type: "purchase", rule: PUR, exp: { amount: 300000, margin: 16.67, discount: 0, verdict: false } },
    { name: "negative selling -5 (sales)", lines: [L(1, 80, 100, -5)], type: "sales", rule: SAL, exp: { amount: -5, margin: null, discount: 105, verdict: true } },
    { name: "negative tax -5 clamps to 0", lines: [L(1, 80, 100, 100, -5)], type: "sales", rule: SAL, exp: { amount: 100, margin: 20, discount: 0, verdict: false, tax: 0 } },
    { name: "margin exactly 13.00 (purchase)", lines: [L(1, 87, 100, 100)], type: "purchase", rule: PUR, exp: { amount: 87, margin: 13, discount: 0, verdict: false } },
    { name: "margin 12.99", lines: [L(1, 87.01, 100, 100)], type: "purchase", rule: PUR, exp: { amount: 87, margin: 12.99, discount: 0, verdict: true } },
    { name: "discount exactly 25.00", lines: [L(1, 50, 100, 75)], type: "purchase", rule: PUR, exp: { amount: 50, margin: 33.33, discount: 25, verdict: false } },
    { name: "discount 25.01", lines: [L(1, 50, 100, 74.99)], type: "purchase", rule: PUR, exp: { amount: 50, margin: 33.32, discount: 25.01, verdict: true } },
    { name: "sales selling = list", lines: [L(1, 50, 100, 100)], type: "sales", rule: SAL, exp: { amount: 100, margin: 50, discount: 0, verdict: false } },
    { name: "sales selling = list - 0.01", lines: [L(1, 50, 100, 99.99)], type: "sales", rule: SAL, exp: { amount: 99.99, margin: 49.99, discount: 0.01, verdict: true } },
    { name: "selling '' (cleared box)", lines: [L(1, 50, 100, "")], type: "sales", rule: SAL, exp: { amount: 0, margin: null, discount: 100, verdict: true } },
  ];

  test.each(cases)("$name: backend matches expected and poCalc.ts", ({ name, lines, type, rule, exp }) => {
    const { be, f } = both(lines, type, "intra", rule);
    expect(be.lines.map(pick)).toEqual(f.lines.map(pick));
    expect(be.totals).toEqual(f.totals);
    expect(be.approvalRequired).toBe(f.approvalRequired);
    expect(be.totals.subtotal).toBeCloseTo(exp.amount, 2);
    if (lines.length === 1 && lines[0].cost_price > 0) {
      expect(be.lines[0].margin_amount).toBe(Math.round((Number(lines[0].selling_price || 0) - lines[0].cost_price) * lines[0].qty * 100) / 100);
    }
    if (lines.length === 1) {
      expect(be.lines[0].margin_pct).toBe(exp.margin === null ? null : exp.margin);
      expect(be.lines[0].discount_pct).toBe(exp.discount);
    }
    if (exp.tax !== undefined) expect(be.totals.tax_total).toBe(exp.tax);
    expect(be.approvalRequired).toBe(exp.verdict);
    pricingRows.push({ case: name, in: lines.map((l) => `${l.qty}/${l.cost_price}/${l.list_price}/${l.selling_price}/${l.tax_rate}%`).join(" + "), type, expected: exp, backend: { amount: be.totals.subtotal, margin: be.lines[0].margin_pct, discount: be.lines[0].discount_pct, tax: be.totals.tax_total, verdict: be.approvalRequired }, frontendSame: true });
  });

  test("intra GST: CGST = half, SGST = rest (odd paisa); inter: IGST = all", () => {
    const lines = [L(1, 10, 10.05, 10.05, 18)]; // tax 1.81 -> 0.91 / 0.90
    const intra = rules.evaluatePo({ lines, type: "sales", taxMode: "intra", rule: SAL }).totals;
    expect(intra.tax_total).toBe(1.81);
    expect(intra.cgst + intra.sgst).toBeCloseTo(1.81, 10);
    expect(intra.igst).toBe(0);
    const inter = rules.evaluatePo({ lines, type: "sales", taxMode: "inter", rule: SAL }).totals;
    expect(inter).toMatchObject({ cgst: 0, sgst: 0, igst: 1.81 });
    expect(fe.computePo(lines, "sales", "inter", SAL).totals).toEqual(inter);
  });

  test("grand_total = subtotal + tax_total; PO margin only when EVERY line has a cost", () => {
    const t1 = rules.computeTotals([rules.computeLine(L(1, 100, 160, 160), "sales"), rules.computeLine(L(1, 0, 200, 200), "sales")], "intra");
    expect(t1.margin_pct).toBeNull();
    expect(t1.grand_total).toBe(Math.round((t1.subtotal + t1.tax_total) * 100) / 100);
    const t2 = rules.computeTotals([rules.computeLine(L(1, 100, 160, 160), "sales"), rules.computeLine(L(2, 50, 70, 70), "sales")], "intra");
    expect(t2.margin_pct).toBe(Math.round(((300 - 200) / 300) * 10000) / 100);
  });

  test("totals for 1 and 50 lines equal poCalc.ts; 300 random POs identical", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const randLine = () => L(Math.round(rnd() * 1000) / 100 || 0.5, Math.round(rnd() * 100000) / 100, Math.round(rnd() * 150000) / 100, Math.round(rnd() * 150000) / 100, [0, 5, 12, 18, 23, 28][Math.floor(rnd() * 6)]);
    for (const n of [1, 50]) {
      const lines = Array.from({ length: n }, randLine);
      const { be, f } = both(lines, "purchase", "intra", PUR);
      expect(be.totals).toEqual(f.totals);
    }
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 8) }, randLine);
      const type = rnd() > 0.5 ? "purchase" : "sales";
      const mode = rnd() > 0.5 ? "intra" : "inter";
      const rule = type === "purchase" ? PUR : SAL;
      const { be, f } = both(lines, type, mode, rule);
      expect(be.totals).toEqual(f.totals);
      expect(be.lines.map(pick)).toEqual(f.lines.map(pick));
      expect(be.approvalRequired).toBe(f.approvalRequired);
    }
  });

  test("[RECORD] breach messages differ between backend and poCalc.ts (text only, verdict same)", () => {
    const { be, f } = both([L(1, 0, 100, 100)], "purchase", "intra", PUR);
    expect(be.lines[0].breaches[0]).toBe("Cost price not set, margin can't be checked");
    expect(f.lines[0].breaches[0]).toBe("Cost price not set");
  });

  test("rule value null = check off", () => {
    const off = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: true };
    expect(rules.evaluatePo({ lines: [L(1, 0, 100, 1)], type: "purchase", taxMode: "intra", rule: off }).approvalRequired).toBe(false);
  });
});

const create = (u, body) => u.api.post(P, body);
const base = (extra = {}) => ({ type: "purchase", division: "brady", items: [S.line(A.items.I1, 2)], ...extra });

describe("2.2 POSITIVE", () => {
  // R1 + R2: only Purchase POs, numbered "<prefix>/<nn>/<FY>" per division.
  test("create purchase PO for each division; separate number series; sales -> 400", async () => {
    const m = A.users.maker.api;
    const c = String(A.customers.c1._id);
    const out = {};
    for (const division of ["brady", "sparkling"]) {
      const r1 = await create(A.users.maker, { type: "purchase", division, customer: c, items: [S.line(A.items.I1, 1)] });
      const r2 = await create(A.users.maker, { type: "purchase", division, customer: c, items: [S.line(A.items.I1, 1)] });
      expect(r1.status).toBe(201);
      out[division] = [r1.body.po_number, r2.body.po_number];
      const sales = await create(A.users.maker, { type: "sales", division, customer: c, items: [S.line(A.items.I1, 1)] });
      expect(sales.status).toBe(400);
    }
    expect(out).toEqual({
      brady: [`PPO/01/${fy}`, `PPO/02/${fy}`],
      sparkling: [`SPK-PPO/01/${fy}`, `SPK-PPO/02/${fy}`],
    });
    expect((await m.get(P)).body.data.every((p) => p.status === "draft" && p.type === "purchase")).toBe(true);
  });

  test("customer snapshot copied (name, address, GSTIN, state, phone, email)", async () => {
    const r = await create(A.users.maker, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] });
    expect(r.body.customer_snapshot).toEqual({ name: "Acme A", address: "1 Road, Surat, Gujarat, 395001", gstin: "24ABCDE1234F1Z5", state: "Gujarat", phone: "9876543210", whatsapp: "9876543210", email: "acme@x.test" });
    expect(r.body.supplier.name).toBe("Brady");
  });

  // Q1 (round 28): cost = Master Distributor Price when the item has one (I1:
  // 150), else the old landing cost (I6: 10).
  test("lines copied from price master: code, name, HSN, unit, cost (MDP), list; I6 GST = 18+5", async () => {
    const r = await create(A.users.maker, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 2), S.line(A.items.I6, 1)] });
    const [l1, l6] = r.body.items;
    expect(l1).toMatchObject({ item_code: "I1-A", name: "I1 Label A", hsn: "4821", unit: "Nos", cost_price: 150, cost_source: "mdp", list_price: 160, selling_price: 160, tax_rate: 18, rate: 150, amount: 300, tax_amount: 54, margin_pct: 6.25, margin_amount: 20 });
    expect(l6).toMatchObject({ cost_price: 10, cost_source: "landing", list_price: 20, tax_rate: 23, amount: 10, tax_amount: 2.3 });
    expect(r.body.totals).toMatchObject({ subtotal: 310, tax_total: 56.3, cgst: 28.15, sgst: 28.15, grand_total: 366.3 });
  });

  test("edit draft: qty, selling, customer, dates, GST mode, notes", async () => {
    const r = await create(A.users.maker, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] });
    const e = await A.users.maker.api.put(`${P}/${r.body._id}`, {
      customer: String(A.customers.c2._id), po_date: `${year}-03-15`, expected_date: `${year}-04-01`, tax_mode: "inter", notes: "deliver fast",
      items: [S.line(A.items.I1, 5, { selling_price: 170 })],
    });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ tax_mode: "inter", notes: "deliver fast" });
    expect(e.body.customer_snapshot.name).toBe("Beta A");
    // The PO to Brady prints the cost (150); the selling price only drives the margin.
    expect(e.body.items[0]).toMatchObject({ qty: 5, selling_price: 170, rate: 150, amount: 750, margin_amount: 100 });
    expect(e.body.totals).toMatchObject({ subtotal: 750, igst: 135, cgst: 0, grand_total: 885 });
    expect(new Date(e.body.po_date).toISOString().slice(0, 10)).toBe(`${year}-03-15`);
    expect(e.body.history.map((h) => h.action)).toEqual(["created", "edited"]);
  });

  // Round 29 (S4): REVERSED — the customer is required now (no "stock" PO).
  test("[REVERSED r29] purchase PO without a customer -> 400 'Customer is required'", async () => {
    for (const customer of [null, ""]) {
      const r = await create(A.users.maker, base({ customer }));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ message: "Customer is required", field: "customer" });
    }
  });

  test("GET /:id returns the PO with populated names and its PDF format", async () => {
    const r = await create(A.users.maker, base());
    const g = await A.users.viewer.api.get(`${P}/${r.body._id}`);
    expect(g.status).toBe(200);
    expect(g.body.created_by.firstname).toBe("maker");
    expect(g.body.format.title_purchase).toBe("Purchase Order");
  });
});

describe("2.3 NEGATIVE", () => {
  const m = () => A.users.maker.api;
  // R1: a missing type now means Purchase PO (the only kind); others -> 400.
  test("type missing -> purchase; 'other' / 'sales' -> 400", async () => {
    const r = await m().post(P, base({ type: undefined }));
    expect(r.status).toBe(201);
    expect(r.body.type).toBe("purchase");
    expect((await m().post(P, base({ type: "other" }))).status).toBe(400);
    expect((await m().post(P, base({ type: "sales", customer: String(A.customers.c1._id) }))).status).toBe(400);
  });
  test("division missing / unknown -> 400", async () => {
    expect((await m().post(P, base({ division: undefined }))).status).toBe(400);
    expect((await m().post(P, base({ division: "nope" }))).status).toBe(400);
  });
  test("division inactive -> 400 (switched off in settings)", async () => {
    const s = (await A.users.admin.api.get(`${P}/settings`)).body;
    const divs = s.divisions.map((d) => (d.key === "sparkling" ? { ...d, active: false } : d));
    expect((await A.users.admin.api.put(`${P}/settings`, { divisions: divs })).status).toBe(200);
    expect((await m().post(P, base({ division: "sparkling" }))).status).toBe(400);
    await A.users.admin.api.put(`${P}/settings`, { divisions: s.divisions });
    expect((await m().post(P, base({ division: "sparkling" }))).status).toBe(201);
  });
  test("items empty / not an array / missing -> 400", async () => {
    for (const items of [[], "abc", { a: 1 }, undefined, null]) {
      expect((await m().post(P, base({ items }))).status).toBe(400);
    }
  });
  // Round 29 (S4): the same item on a PO twice is merged (qty added) with a
  // warning; at most 500 lines are accepted.
  test("[r29] 500 lines of the same item -> ONE line, qty 500, with a merge warning; 501 lines -> 400", async () => {
    const r = await m().post(P, base({ items: Array.from({ length: 500 }, () => S.line(A.items.I1, 1)) }));
    expect(r.status).toBe(201);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].qty).toBe(500);
    expect(r.body.warnings).toEqual(["The same item was on the PO more than once — merged into line 1 (qty 500)"]);
    const big = await m().post(P, base({ items: Array.from({ length: 501 }, () => S.line(A.items.I1, 1)) }));
    expect(big.status).toBe(400);
    expect(big.body.message).toBe("At most 500 items on one PO");
  });
  test("item_id invalid / missing / unknown -> 400 'pick the item from the PO items'", async () => {
    for (const item_id of ["bad", undefined, String(new mongoose.Types.ObjectId())]) {
      const r = await m().post(P, base({ items: [{ item_id, qty: 1 }] }));
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/pick the item from the PO items/);
    }
  });
  test("qty 0, -1, 'abc', '', null -> 400", async () => {
    for (const qty of [0, -1, "abc", "", null]) {
      expect((await m().post(P, base({ items: [S.line(A.items.I1, qty)] }))).status).toBe(400);
    }
  });
  // Round 29 (S4): FIXED — qty is a whole number from 1 to 1,00,000.
  test("[FIXED r29] qty 1e9 -> 400 'can't be more than 1,00,000'; 100000 OK (finding 2b)", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1e9)] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: quantity can't be more than 1,00,000");
    expect((await m().post(P, base({ items: [S.line(A.items.I1, 100000)] }))).status).toBe(201);
  });
  test("[FIXED r29] qty 0.5 / 1.5 -> 400 'must be a whole number' (finding 2b)", async () => {
    for (const qty of [0.5, 1.5, "2.5"]) {
      const r = await m().post(P, base({ items: [S.line(A.items.I1, qty)] }));
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Line 1: quantity must be a whole number");
    }
  });
  // Round 28: the customer's selling price is on the Purchase PO (R6).
  const sales1 = (extra) => ({ type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 2, extra)] });
  test("[FIXED] selling_price -5 -> 400 'can't be negative' (finding 2b)", async () => {
    const r = await m().post(P, sales1({ selling_price: -5 }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: selling price can't be negative");
  });
  test("[FIXED] selling_price 'abc' -> 400 'enter a number' (no silent list price)", async () => {
    const r = await m().post(P, sales1({ selling_price: "abc" }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: selling price: enter a number");
  });
  test("[FIXED] residual: selling_price [5] (array) / true / false / {} and tax_rate [18] -> 400 'enter a number' (were coerced by Number())", async () => {
    for (const v of [[5], ["5"], true, false, {}]) {
      const r = await m().post(P, sales1({ selling_price: v }));
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Line 1: selling price: enter a number");
    }
    const t = await m().post(P, sales1({ tax_rate: [18] }));
    expect(t.status).toBe(400);
    expect(t.body.message).toBe("Line 1: GST %: enter a number");
  });
  test("selling_price 'Infinity' / object -> 400; second line reported as 'Line 2'", async () => {
    for (const v of ["Infinity", { $gt: 1 }, "1e400", "5 5"]) {
      const r = await m().post(P, sales1({ selling_price: v }));
      expect(r.status).toBe(400);
    }
    const two = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1), S.line(A.items.I1, 1, { selling_price: "x" })] });
    expect(two.body.message).toBe("Line 2: selling price: enter a number");
  });
  // R6: the Purchase PO now has the floor too (selling 0 is below the End
  // User Price 160), so the number parsing is checked with prices >= 160.
  test("valid selling / tax numbers still work: numeric strings, 0 GST, decimals, null = default", async () => {
    // Round 29 (S4): one PO per line — the same item twice on one PO is merged now.
    const out = [];
    for (const extra of [{ selling_price: "170.5", tax_rate: "12" }, { selling_price: "160", tax_rate: 0 }, { selling_price: null, tax_rate: null }, { tax_rate: 100 }]) {
      const r = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, extra)] });
      expect(r.status).toBe(201);
      out.push([r.body.items[0].selling_price, r.body.items[0].tax_rate]);
    }
    expect(out).toEqual([[170.5, 12], [160, 0], [160, 18], [160, 100]]);
    const zero = await m().post(P, base({ items: [S.line(A.items.I1, 1, { selling_price: 0 })] }));
    expect(zero.status).toBe(400);
  });
  // Round 29 (S4): FIXED — prices 0 to 1,00,00,000 with at most 2 decimals.
  test("[FIXED r29] selling_price 1e12 -> 400; 3 decimals -> 400; 1,00,00,000 OK", async () => {
    const r = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, { selling_price: 1e12 })] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: selling price can't be more than 1,00,00,000");
    const dec = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, { selling_price: 170.555 })] });
    expect(dec.body.message).toBe("Line 1: selling price: at most 2 decimals");
    const max = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, { selling_price: 10000000 })] });
    expect(max.status).toBe(201);
    expect(max.body.items[0]).toMatchObject({ selling_price: 1e7, amount: 150 });
  });
  test("tax_rate -5 -> 400 'can't be negative' (finding 2c: now rejected instead of clamped to 0)", async () => {
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: -5 })] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: GST % can't be negative");
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("[FIXED] tax_rate 1000 -> 400 'can't be more than 100'; 100.01 -> 400", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: 1000 })] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: GST % can't be more than 100");
    expect((await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: 100.01 })] }))).status).toBe(400);
  });
  test("[FIXED] tax_rate 'abc' / '' -> 400 (no silent fallback to the item tax)", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: "abc" })] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: GST %: enter a number");
    expect((await m().post(P, base({ items: [S.line(A.items.I1, 1, { tax_rate: "" })] }))).status).toBe(400);
  });
  test("edit with an invalid line amount -> 400 and the draft is unchanged", async () => {
    const d = (await m().post(P, base())).body;
    const e = await m().put(`${P}/${d._id}`, { items: [S.line(A.items.I1, 5, { selling_price: -1 })] });
    expect(e.status).toBe(400);
    expect((await PurchaseOrder().findById(d._id).lean()).items[0].qty).toBe(2);
  });
  // Fixed in round 28 (the FY number series checks the date first).
  test("[FIXED] po_date invalid -> 400 and no counter is used", async () => {
    const r = await m().post(P, base({ po_date: "abc" }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("PO date is not a valid date");
    const s = await PoSettings().findOne({ tenant_id: A.tenantId }).lean();
    expect(Object.keys(s.counters).filter((k) => /NaN|null|undefined/.test(k))).toEqual([]);
  });
  test("[FIXED] expected_date invalid -> 400", async () => {
    const r = await m().post(P, base({ expected_date: "not-a-date" }));
    expect(r.status).toBe(400);
  });
  // Round 29 (S4): FIXED — expected delivery can't be before the PO date.
  test("[FIXED r29] expected_date before po_date -> 400; same day OK", async () => {
    const r = await m().post(P, base({ po_date: `${year}-06-10`, expected_date: `${year}-06-01` }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ message: "Expected delivery can't be before the PO date", field: "expected_date" });
    expect((await m().post(P, base({ po_date: `${year}-06-10`, expected_date: `${year}-06-10` }))).status).toBe(201);
  });
  test("[RECORD] notes 50,000 chars + HTML stored raw", async () => {
    const notes = "<img src=x onerror=\"window.__xss=1\">" + "n".repeat(50000);
    const r = await m().post(P, base({ notes }));
    expect(r.status).toBe(201);
    expect(r.body.notes).toBe(notes);
  });
  test("customer invalid id -> 400; other company's customer -> 400 (finding 2h)", async () => {
    const s = { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] };
    expect((await m().post(P, { ...s, customer: "bad" })).status).toBe(400);
    const r = await m().post(P, { ...s, customer: String(B.customers.c1._id) });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Unknown customer");
    // also on a purchase PO (optional customer)
    expect((await m().post(P, base({ customer: String(B.customers.c1._id) }))).status).toBe(400);
  });
  test("sales PO -> 400 (removed); purchase without customer -> 201 (stock order) (finding 2g)", async () => {
    expect((await m().post(P, { type: "sales", division: "brady", items: [S.line(A.items.I1, 1)] })).status).toBe(400);
    expect((await m().post(P, base())).status).toBe(201);
  });
  test("Tenant B item id -> 400, nothing from B copied (finding 2i)", async () => {
    const before = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    const r = await m().post(P, base({ items: [S.line(B.items.I1, 1)] }));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/pick the item from the PO items/);
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(before);
    expect(JSON.stringify(r.body)).not.toMatch(/I1 Label B/);
  });
  test("posted cost_price / list_price / rate / amount are IGNORED (finding 2a)", async () => {
    const r = await m().post(P, base({ items: [S.line(A.items.I1, 1, { cost_price: 1, list_price: 1, rate: 1, amount: 1, tax_amount: 0, margin_pct: 99, name: "Fake", item_code: "FAKE" })] }));
    expect(r.body.items[0]).toMatchObject({ cost_price: 150, list_price: 160, rate: 150, amount: 150, name: "I1 Label A", item_code: "I1-A", margin_pct: 6.25 });
    const e = await m().put(`${P}/${r.body._id}`, { items: [S.line(A.items.I1, 1, { cost_price: 1, list_price: 1 })] });
    expect(e.body.items[0]).toMatchObject({ cost_price: 150, list_price: 160 });
  });
  test("extra body fields (status, approval, totals, po_number, tenant_id, created_by, history) ignored", async () => {
    const r = await m().post(P, base({
      status: "approved", approval: { required: false, decision: "approved" }, totals: { grand_total: 1 }, po_number: "HACK-1",
      tenant_id: String(B.tenantId), created_by: String(A.users.admin.id), history: [{ action: "approved" }], format_version: 99, supplier: { name: "Evil" }, rule_snapshot: { min_margin_pct: 0 },
    }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "draft", tenant_id: String(A.tenantId), created_by: String(A.users.maker.id), format_version: 1 });
    expect(r.body.po_number).not.toBe("HACK-1");
    expect(r.body.totals.grand_total).toBe(354); // 2 x MDP 150 + 18 %
    expect(r.body.history.map((h) => h.action)).toEqual(["created"]);
    expect(r.body.supplier.name).toBe("Brady");
    expect(r.body.rule_snapshot.min_margin_pct).toBe(13);
  });
  test("[RECORD] tax_mode 'xyz' -> intra (finding 2d: user picks GST mode, not derived from state)", async () => {
    const r = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), tax_mode: "xyz", items: [S.line(A.items.I1, 1)] });
    expect(r.body.tax_mode).toBe("intra");
    const r2 = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), tax_mode: "inter", items: [S.line(A.items.I1, 1)] });
    // Customer is in Gujarat, supplier state blank: server does not check, inter is kept.
    expect(r2.body.tax_mode).toBe("inter");
  });
  test("edit only in draft: pending / approved -> 400 (finding 2f)", async () => {
    const pend = await m().post(P, base({ items: [S.line(A.items.I2, 1)], submit: true }));
    expect(pend.body.status).toBe("pending_approval");
    expect((await m().put(`${P}/${pend.body._id}`, base())).status).toBe(400);
    // R4: the admin's own PO waits too; the admin then says Yes (Q7).
    const sub = await A.users.admin.api.post(P, base({ submit: true }));
    expect(sub.body.status).toBe("pending_approval");
    const appr = await A.users.admin.api.post(`${P}/${sub.body._id}/approve`, {});
    expect(appr.body.status).toBe("approved");
    const r = await A.users.admin.api.put(`${P}/${appr.body._id}`, base());
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Approved POs are locked");
  });
  test("edit: old sales PO -> 400 (read-only); Edit cap missing -> 403; unknown id -> 404", async () => {
    const old = await S.insertSalesPo(A);
    const ro = await m().put(`${P}/${old._id}`, { customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] });
    expect(ro.status).toBe(400);
    expect(ro.body.message).toMatch(/read-only/);
    const s = await m().post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] });
    expect((await A.users.own.api.put(`${P}/${s.body._id}`, { items: [S.line(A.items.I1, 1)] })).status).toBe(403);
    expect((await m().put(`${P}/${new mongoose.Types.ObjectId()}`, base())).status).toBe(404);
  });
  test("[RECORD] edit clears expected_date and notes when omitted from body", async () => {
    const r = await m().post(P, base({ expected_date: `${year}-12-01`, notes: "keep me" }));
    const e = await m().put(`${P}/${r.body._id}`, { items: [S.line(A.items.I1, 1)] });
    expect(e.body.notes).toBeUndefined();
    expect(e.body.expected_date).toBeUndefined();
  });
});

describe("2.x NUMBERING (finding 2e)", () => {
  test("10 parallel creates get 10 different numbers (atomic $inc)", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => B.users.admin.api.post(P, { type: "purchase", division: "sparkling", customer: String(B.customers.c1._id), items: [S.line(B.items.I1, 1)] })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const nums = rs.map((r) => r.body.po_number).sort();
    expect(new Set(nums).size).toBe(10);
    expect(nums[0]).toBe(`SPK-PPO/01/${fy}`);
    expect(nums[9]).toBe(`SPK-PPO/10/${fy}`);
  });

  // R2: the series runs per financial year (April-March).
  test("back-dated PO uses that financial year's series", async () => {
    const back = `${year - 2}-12-20`;
    const r = await B.users.admin.api.post(P, { type: "purchase", division: "sparkling", po_date: back, items: [S.line(B.items.I1, 1)] });
    expect(r.body.po_number).toBe(`SPK-PPO/01/${require("../../services/purchaseOrderRules").fyOf(back)}`);
    const r2 = await B.users.admin.api.post(P, { type: "purchase", division: "sparkling", items: [S.line(B.items.I1, 1)] });
    expect(r2.body.po_number).toBe(`SPK-PPO/11/${fy}`);
  });

  test("[BUG] counter is bumped before save: a failed save leaves a gap in the series", async () => {
    const u = B.users.admin.api;
    const ok1 = await u.post(P, { type: "purchase", division: "brady", items: [S.line(B.items.I1, 1)] });
    // notes as an object -> Mongoose cast error at save, AFTER nextNumber()
    const bad = await u.post(P, { type: "purchase", division: "brady", notes: { $gt: "" }, items: [S.line(B.items.I1, 1)] });
    expect(bad.status).toBe(500);
    const ok2 = await u.post(P, { type: "purchase", division: "brady", items: [S.line(B.items.I1, 1)] });
    const n1 = Number(ok1.body.po_number.split("/")[1]);
    const n2 = Number(ok2.body.po_number.split("/")[1]);
    expect(n2 - n1).toBe(2); // one number lost
  });

  test("[RECORD] editing po_date into another year keeps the old year's number", async () => {
    const u = B.users.admin.api;
    const r = await u.post(P, { type: "purchase", division: "brady", items: [S.line(B.items.I1, 1)] });
    const e = await u.put(`${P}/${r.body._id}`, { po_date: `${year - 3}-05-05`, items: [S.line(B.items.I1, 1)] });
    expect(e.body.po_number).toBe(r.body.po_number);
    expect(e.body.po_number).toContain(`/${fy}`);
  });
});

describe("2.5 INTEGRATION", () => {
  test("20 random POs: server totals == poCalc.ts totals from the same price-master data", async () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const itemsArr = Object.values(A.items);
    const Item = require("../../models/PoItem");
    const { costOf } = require("../../services/purchaseOrderRules");
    for (let i = 0; i < 20; i++) {
      rnd(); // (was the PO type — only Purchase POs now; keeps the same random stream)
      const type = "purchase";
      const mode = rnd() > 0.5 ? "intra" : "inter";
      const n = 1 + Math.floor(rnd() * 5);
      const posted = Array.from({ length: n }, () => {
        const it = itemsArr[Math.floor(rnd() * itemsArr.length)];
        // R6: the selling price can't go below list, so it is list + 0..300
        const selling = Math.round(rnd() * 30000) / 100;
        // Round 29 (S4): whole-number qty (1-91).
        return { item_id: String(it._id), qty: Math.round(rnd() * 90 + 1), selling_price: rules.round2(it.end_customer_price + selling), tax_rate: [5, 12, 18][Math.floor(rnd() * 3)] };
      }).reduce((acc, l) => {
        // Round 29 (S4): the same item twice is merged by the server (qty
        // added, the first line's price kept) — and by the editor; post it merged.
        const same = acc.find((x) => x.item_id === l.item_id);
        if (same) same.qty += l.qty;
        else acc.push(l);
        return acc;
      }, []);
      const body = { type, division: "brady", tax_mode: mode, customer: String(A.customers.c1._id), items: posted };
      const r = await A.users.maker.api.post(P, body);
      expect(r.status).toBe(201);
      // What the editor would show (prices from the price list rows the UI loads)
      const uiLines = [];
      for (const p of posted) {
        const it = await Item.findById(p.item_id).lean();
        uiLines.push({ name: it.name, qty: p.qty, ...costOf(it), list_price: it.end_customer_price || 0, selling_price: p.selling_price, tax_rate: p.tax_rate });
      }
      // Round 28 purchase rule: floor on, min margin 13, no discount limit.
      const ui = fe.computePo(uiLines, type, mode, { ...PUR, max_discount_pct: null, allow_below_list: false, price_floor: true });
      expect(r.body.totals).toEqual(ui.totals);
      // R4: approval is always required; the reasons match what the editor shows.
      expect(r.body.approval.required).toBe(true);
      expect(r.body.approval.reasons.length > 0).toBe(ui.approvalRequired);
    }
  });

  test("delete the customer and the item after the PO is made -> PO still opens with its snapshot; edit keeps old prices (finding 2f)", async () => {
    const Client = require("../../models/Client");
    const Item = require("../../models/PoItem");
    const cust = await Client.create({ company: "Temp Cust", tenant_id: A.tenantId, phonenumber: "9999999999" });
    const it = await Item.create({ name: "Temp Item", item_code: "TMP", tenant_id: A.tenantId, cost_price: 40, end_customer_price: 60 });
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(cust._id), items: [S.line(it, 2)] });
    await Client.deleteOne({ _id: cust._id });
    await Item.deleteOne({ _id: it._id });
    const g = await A.users.maker.api.get(`${P}/${r.body._id}`);
    expect(g.status).toBe(200);
    expect(g.body.customer_snapshot.name).toBe("Temp Cust");
    expect(g.body.items[0]).toMatchObject({ name: "Temp Item", cost_price: 40, list_price: 60 });
    // Edit keeps the deleted item's old prices, but the deleted customer can't be kept
    const e1 = await A.users.maker.api.put(`${P}/${r.body._id}`, { customer: String(cust._id), items: [S.line(it, 3)] });
    expect(e1.status).toBe(400);
    expect(e1.body.message).toBe("Unknown customer");
    const e2 = await A.users.maker.api.put(`${P}/${r.body._id}`, { customer: String(A.customers.c1._id), items: [S.line(it, 3)] });
    expect(e2.status).toBe(200);
    expect(e2.body.items[0]).toMatchObject({ name: "Temp Item", qty: 3, cost_price: 40, list_price: 60, selling_price: 60 });
  });

  test("[FIXED] selling_price '' (cleared box): server now answers 400 instead of pricing it differently from the UI", async () => {
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1, { selling_price: "" })] });
    const ui = fe.computePo([{ name: "I1", qty: 1, cost_price: 100, list_price: 160, selling_price: "", tax_rate: 18 }], "sales", "intra", SAL);
    expect(ui.totals.subtotal).toBe(0);
    expect(ui.approvalRequired).toBe(true);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Line 1: selling price: enter a number");
  });

  test("item price change between create and edit: edit re-prices from today's master", async () => {
    const Item = require("../../models/PoItem");
    const it = await Item.create({ name: "Moving Price", tenant_id: A.tenantId, cost_price: 10, end_customer_price: 20 });
    const r = await A.users.maker.api.post(P, base({ items: [S.line(it, 1)] }));
    await Item.updateOne({ _id: it._id }, { cost_price: 12, end_customer_price: 25 });
    const e = await A.users.maker.api.put(`${P}/${r.body._id}`, { items: [S.line(it, 1)] });
    expect(e.body.items[0]).toMatchObject({ cost_price: 12, list_price: 25 });
  });
});
