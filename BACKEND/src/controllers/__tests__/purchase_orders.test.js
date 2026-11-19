const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const Item = require("../../models/Item");
const PoItem = require("../../models/PoItem");
const Client = require("../../models/Client");
const PurchaseOrder = require("../../models/PurchaseOrder");
const PoSettings = require("../../models/PoSettings");
const { requireTenantFeature } = require("../../utils/tenantFeatures");
const { evaluatePo, computeLine, fyOf } = require("../../services/purchaseOrderRules");
const po = require("../purchase_order_controller");
const { createItem, updateItem } = require("../item_controller");

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
};

// Round 29 (S4): a PO needs a customer. Create / edit bodies that don't name
// one get the test customer "Acme Ltd" (set in beforeAll); the test of the
// rule itself sends customer: null.
let defaultCustomer = null;
const call = async (handler, user, { body = {}, params = {}, query = {}, permissionLevel = "global" } = {}) => {
  if ((handler === po.createPurchaseOrder || handler === po.updatePurchaseOrder) && defaultCustomer && body && !("customer" in body)) {
    body = { ...body, customer: defaultCustomer };
  }
  const res = mockRes();
  const req = { user, userRole: "staff", body, params, query, permissionLevel, app: { get: () => null } };
  await handler(req, res);
  const status = res.status.mock.calls.length ? res.status.mock.calls[res.status.mock.calls.length - 1][0] : 200;
  return { status, body: res.body };
};

const PURCHASE_RULE = { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true };
const SALES_RULE = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false };

describe("Purchase order pricing rules", () => {
  const line = (selling, cost = 70, list = 100) => ({ name: "Label", qty: 2, cost_price: cost, list_price: list, selling_price: selling, tax_rate: 18 });

  test("purchase line prints cost price, sales line prints selling price", () => {
    expect(computeLine(line(90), "purchase").rate).toBe(70);
    expect(computeLine(line(90), "sales").rate).toBe(90);
  });

  test("margin and discount maths", () => {
    const l = computeLine(line(80), "purchase");
    expect(l.margin_pct).toBe(12.5); // (80-70)/80
    expect(l.discount_pct).toBe(20); // (100-80)/100
  });

  test("purchase rule: discount <= 25 and margin >= 13 passes, at the limits too", () => {
    expect(evaluatePo({ lines: [line(100)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).approvalRequired).toBe(false);
    // exactly 13% margin: cost 87 on 100
    expect(evaluatePo({ lines: [line(100, 87)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).approvalRequired).toBe(false);
    // exactly 25% discount, cost low enough for margin
    expect(evaluatePo({ lines: [line(75, 50)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).approvalRequired).toBe(false);
  });

  test("purchase rule: low margin, high discount or missing cost needs approval", () => {
    expect(evaluatePo({ lines: [line(80)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).reasons[0]).toMatch(/Margin 12.5%/);
    expect(evaluatePo({ lines: [line(74, 10)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).reasons[0]).toMatch(/Discount 26%/);
    expect(evaluatePo({ lines: [line(100, 0)], type: "purchase", taxMode: "intra", rule: PURCHASE_RULE }).reasons[0]).toMatch(/Cost price not set/);
  });

  test("sales rule: at or above list is free, below list needs approval", () => {
    expect(evaluatePo({ lines: [line(100)], type: "sales", taxMode: "intra", rule: SALES_RULE }).approvalRequired).toBe(false);
    expect(evaluatePo({ lines: [line(120)], type: "sales", taxMode: "intra", rule: SALES_RULE }).approvalRequired).toBe(false);
    expect(evaluatePo({ lines: [line(99.5)], type: "sales", taxMode: "intra", rule: SALES_RULE }).approvalRequired).toBe(true);
  });

  test("GST splits into CGST/SGST or IGST", () => {
    const intra = evaluatePo({ lines: [line(100)], type: "sales", taxMode: "intra", rule: SALES_RULE }).totals;
    expect(intra).toMatchObject({ subtotal: 200, cgst: 18, sgst: 18, igst: 0, grand_total: 236 });
    const inter = evaluatePo({ lines: [line(100)], type: "sales", taxMode: "inter", rule: SALES_RULE }).totals;
    expect(inter).toMatchObject({ cgst: 0, sgst: 0, igst: 36, grand_total: 236 });
  });
});

describe("Purchase Orders module", () => {
  let mongoServer, trinetra, other, admin, maker, approver, otherAdmin, item, lowCostItem, customer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) throw new Error("Not an in-memory DB");
    await mongoose.connect(uri);

    trinetra = await Tenant.create({ company_name: "Trinetra", status: "active", enabled_features: ["purchase_orders"] });
    other = await Tenant.create({ company_name: "Other Co", status: "active" });
    // Purchase Orders is limited to the tenant ids in this env var (config/tenantFeatures).
    process.env.PURCHASE_ORDERS_TENANT_IDS = String(trinetra._id);

    const makerRole = await Role.create({
      name: "Sales Engineer",
      tenant_id: trinetra._id,
      permissions: { "Purchase Orders": { "View (Own)": true, Create: true, Edit: true } },
    });
    const approverRole = await Role.create({
      name: "PO Approver",
      tenant_id: trinetra._id,
      permissions: { "Purchase Orders": { "View(Global)": true, Approve: true, "Manage Prices": true } },
    });

    admin = await Staff.create({ firstname: "Owner", lastname: "T", email: "owner@t.test", password: "x", admin: true, tenant_id: trinetra._id });
    maker = await Staff.create({ firstname: "Maker", lastname: "T", email: "maker@t.test", password: "x", tenant_id: trinetra._id, role: makerRole._id });
    approver = await Staff.create({ firstname: "Approver", lastname: "T", email: "appr@t.test", password: "x", tenant_id: trinetra._id, role: approverRole._id });
    otherAdmin = await Staff.create({ firstname: "Other", lastname: "O", email: "o@o.test", password: "x", admin: true, tenant_id: other._id });

    // PO items live in the PO module (PoItem), not in the CRM Items module.
    // Brady flow (Q1): the cost is the Master Distributor Price (70 here).
    item = await PoItem.create({
      name: "Brady Label", tenant_id: trinetra._id, item_code: "BR-1",
      master_price: 70, cost_price: 70, distributor_price: 90, end_customer_price: 100,
    });
    lowCostItem = await PoItem.create({ name: "No Cost Item", tenant_id: trinetra._id, end_customer_price: 50 });
    customer = await Client.create({ company: "Acme Ltd", tenant_id: trinetra._id, phonenumber: "9876543210" });
    defaultCustomer = String(customer._id);

    // The default is Brady only and new divisions can't be added through the
    // API; the numbering test needs a second one, so it is put straight into
    // the (in-memory) settings, like an older company that still has it.
    expect((await call(po.getPoSettings, admin)).body.divisions.map((d) => d.key)).toEqual(["brady"]);
    await PoSettings.updateOne(
      { tenant_id: trinetra._id },
      { $push: { divisions: { key: "sparkling", name: "Sparkling", purchase_prefix: "SPK-PPO", sales_prefix: "SPK-SPO", active: true } } }
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test("a company without the add-on is blocked", async () => {
    const res = mockRes();
    const next = jest.fn();
    await requireTenantFeature("purchase_orders")({ user: otherAdmin }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);

    const ok = jest.fn();
    await requireTenantFeature("purchase_orders")({ user: maker }, mockRes(), ok);
    expect(ok).toHaveBeenCalled();
  });

  // R2 numbering "<prefix>/<nn>/<FY>"; R1: no Sales PO series any more.
  test("numbering is separate per division; a Sales PO can't be made", async () => {
    const fy = fyOf(new Date());
    const a = await call(po.createPurchaseOrder, admin, { body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1 }] } });
    const b = await call(po.createPurchaseOrder, admin, { body: { type: "purchase", division: "sparkling", items: [{ item_id: item._id, qty: 1 }] } });
    const c = await call(po.createPurchaseOrder, admin, { body: { type: "sales", division: "brady", customer: customer._id, items: [{ item_id: item._id, qty: 1 }] } });
    const d = await call(po.createPurchaseOrder, admin, { body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1 }] } });
    expect(a.body.po_number).toBe(`PPO/01/${fy}`);
    expect(b.body.po_number).toBe(`SPK-PPO/01/${fy}`);
    expect(c.status).toBe(400);
    expect(d.body.po_number).toBe(`PPO/02/${fy}`);
  });

  // R4: within the rules the PO still waits for an approver's Yes.
  // Round 29 (S4): a "stock" PO without a customer is refused now (customer required).
  test("purchase PO within rules goes to pending approval on submit; no customer -> 400", async () => {
    const stock = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", customer: null, items: [{ item_id: item._id, qty: 5 }], submit: true },
    });
    expect(stock.status).toBe(400);
    expect(stock.body).toMatchObject({ message: "Customer is required", field: "customer" });
    const r = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 5 }], submit: true },
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval).toMatchObject({ required: true, reasons: [] });
    expect(String(r.body.customer)).toBe(defaultCustomer);
    expect(r.body.items[0]).toMatchObject({ rate: 70, selling_price: 100, cost_price: 70, margin_pct: 30 });
    expect(r.body.supplier.name).toBe("Brady");
  });

  test("cost price can't be overridden from the request", async () => {
    const r = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1, cost_price: 1, list_price: 1 }] },
    });
    expect(r.body.items[0]).toMatchObject({ cost_price: 70, list_price: 100 });
  });

  test("items must come from the price list", async () => {
    const r = await call(po.createPurchaseOrder, maker, { body: { type: "purchase", division: "brady", items: [{ name: "Typed item", qty: 1 }] } });
    expect(r.status).toBe(400);
  });

  test("sales PO can't be made any more (R1)", async () => {
    const r = await call(po.createPurchaseOrder, maker, { body: { type: "sales", division: "brady", customer: customer._id, items: [{ item_id: item._id, qty: 1 }] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Sales PO was removed/);
  });

  test("raised price -> pending (reason shown); No needs a reason and returns to draft; Yes locks it", async () => {
    const created = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 2, selling_price: 78 }], submit: true },
    });
    // R6: below the End User Price (100) is refused outright.
    expect(created.status).toBe(400);
    const raised = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 2, selling_price: 110 }], submit: true },
    });
    expect(raised.body.status).toBe("pending_approval");
    expect(raised.body.approval.reasons.join(" ")).toMatch(/Price raised from 100 to 110/);
    Object.assign(created, raised);
    const id = String(created.body._id);

    expect((await call(po.updatePurchaseOrder, maker, { params: { id }, body: { items: [{ item_id: item._id, qty: 3 }] } })).status).toBe(400);
    expect((await call(po.approvePurchaseOrder, maker, { params: { id } })).status).toBe(403);
    expect((await call(po.rejectPurchaseOrder, approver, { params: { id }, body: {} })).status).toBe(400);

    const rejected = await call(po.rejectPurchaseOrder, approver, { params: { id }, body: { reason: "Margin too low" } });
    expect(rejected.body.status).toBe("draft");
    expect(rejected.body.approval.reason).toBe("Margin too low");

    const resubmitted = await call(po.updatePurchaseOrder, maker, {
      params: { id }, body: { items: [{ item_id: item._id, qty: 2, selling_price: 100 }], submit: true },
    });
    expect(resubmitted.body.status).toBe("pending_approval");

    const approved = await call(po.approvePurchaseOrder, approver, { params: { id } });
    expect(approved.body.status).toBe("approved");
    expect(String(approved.body.approval.decided_by)).toBe(String(approver._id));

    const edit = await call(po.updatePurchaseOrder, maker, { params: { id }, body: { items: [{ item_id: item._id, qty: 9 }] } });
    expect(edit.status).toBe(400);
  });

  test("missing cost price sends the PO for approval", async () => {
    const r = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", items: [{ item_id: lowCostItem._id, qty: 1 }], submit: true },
    });
    expect(r.body.status).toBe("pending_approval");
  });

  // G1 "price only up", now on the Purchase PO (R6): at list -> pending with
  // nothing to point out, raised -> pending with the reason, below -> refused.
  test("customer price on a purchase PO: at list pending, above list pending (raised), below list refused", async () => {
    const at = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", customer: customer._id, items: [{ item_id: item._id, qty: 1, selling_price: 100 }], submit: true },
    });
    expect(at.body.status).toBe("pending_approval");
    expect(at.body.approval.reasons).toEqual([]);
    expect(at.body.customer_snapshot.name).toBe("Acme Ltd");

    const up = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", customer: customer._id, items: [{ item_id: item._id, qty: 1, selling_price: 110 }], submit: true },
    });
    expect(up.body.status).toBe("pending_approval");
    expect(up.body.items[0].rate).toBe(70); // the PO to Brady prints the cost
    expect(up.body.approval.reasons).toEqual(["Line 1 (Brady Label): Price raised from 100 to 110"]);

    const down = await call(po.createPurchaseOrder, maker, {
      body: { type: "purchase", division: "brady", customer: customer._id, items: [{ item_id: item._id, qty: 1, selling_price: 95 }], submit: true },
    });
    expect(down.status).toBe(400);
    expect(down.body.message).toBe("Line 1 (Brady Label): price can't be lower than the price-master price 100");
  });

  // R4 + Q7: an approver's own PO is NOT approved on submit; they press Yes.
  test("an approver's own PO waits; the approver may then say Yes to it", async () => {
    const r = await call(po.createPurchaseOrder, admin, {
      body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1, selling_price: 120 }], submit: true },
    });
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.decision).toBeUndefined();
    const yes = await call(po.approvePurchaseOrder, admin, { params: { id: String(r.body._id) } });
    expect(yes.body.status).toBe("approved");
    expect(yes.body.approval.decision).toBe("approved");
    expect(String(yes.body.approval.decided_by)).toBe(String(admin._id));
  });

  test("View (Own) staff only see their own POs", async () => {
    const mine = await call(po.listPurchaseOrders, maker, { permissionLevel: "own" });
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data.every((p) => String(p.created_by._id) === String(maker._id))).toBe(true);
  });

  test("status moves follow the allowed path", async () => {
    const r = await call(po.createPurchaseOrder, admin, { body: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1 }], submit: true } });
    const id = String(r.body._id);
    expect((await call(po.approvePurchaseOrder, admin, { params: { id } })).body.status).toBe("approved");
    expect((await call(po.changeStatus, admin, { params: { id }, body: { status: "received" } })).status).toBe(400);
    expect((await call(po.changeStatus, admin, { params: { id }, body: { status: "sent" } })).body.status).toBe("sent");
    expect((await call(po.changeStatus, admin, { params: { id }, body: { status: "received" } })).body.status).toBe("received");
  });

  test("prices: plain item edits can't change them; the PO items list can, with permission", async () => {
    const created = mockRes();
    await createItem({ user: maker, body: { name: "Sneaky", cost_price: 1, end_customer_price: 999 } }, created);
    expect(created.body.cost_price).toBe(0);

    // A CRM Item (Items module) keeps its old PO price fields untouched by the form.
    const crmItem = await Item.create({ name: "CRM Brady Label", tenant_id: trinetra._id, cost_price: 70 });
    const updated = mockRes();
    await updateItem({ user: maker, params: { id: String(crmItem._id) }, body: { name: "CRM Brady Label", cost_price: 1 } }, updated);
    expect(updated.body.cost_price).toBe(70);

    expect((await call(po.previewPoItems, maker, { body: { rows: [{ item_code: "BR-1", cost_price: 60 }] } })).status).toBe(403);

    const preview = await call(po.previewPoItems, approver, {
      body: { rows: [{ item_code: "BR-1", cost_price: 65 }, { name: "New Brady Tag", item_code: "BR-2", cost_price: 10, end_customer_price: 20 }, { name: "" }] },
    });
    expect(preview.body.summary).toEqual({ new: 1, update: 1, unchanged: 0, error: 1 });

    const imported = await call(po.importPoItems, approver, {
      body: { rows: [{ item_code: "BR-1", cost_price: 65 }, { name: "New Brady Tag", item_code: "BR-2", cost_price: 10, end_customer_price: 20 }] },
    });
    expect(imported.body).toMatchObject({ updated: 1, created: 1 });
    expect((await PoItem.findById(item._id)).cost_price).toBe(65);
    expect((await PoItem.findById(item._id)).end_customer_price).toBe(100); // blank cell left alone
    expect(await Item.countDocuments({ name: "New Brady Tag" })).toBe(0); // never a CRM Item
  });

  test("settings: only admins; a new format gets a new version and old POs keep theirs", async () => {
    const before = await PurchaseOrder.findOne({ tenant_id: trinetra._id });
    expect((await call(po.updatePoSettings, approver, { body: { supplier: { name: "X" } } })).status).toBe(403);

    const s = await call(po.getPoSettings, admin);
    const format = { ...s.body.format, title_purchase: "PURCHASE ORDER" };
    const saved = await call(po.updatePoSettings, admin, { body: { format, rules: { purchase: { ...PURCHASE_RULE, min_margin_pct: 15 } } } });
    expect(saved.body.format_version).toBe(2);
    expect(saved.body.rules.purchase.min_margin_pct).toBe(15);

    const old = await call(po.getPurchaseOrder, admin, { params: { id: String(before._id) } });
    expect(old.body.format.title_purchase).toBe("Purchase Order");

    const removeUsed = await call(po.updatePoSettings, admin, {
      body: { divisions: [{ key: "brady", name: "Brady", purchase_prefix: "PPO", sales_prefix: "SPO" }] },
    });
    expect(removeUsed.status).toBe(400);
  });
});
