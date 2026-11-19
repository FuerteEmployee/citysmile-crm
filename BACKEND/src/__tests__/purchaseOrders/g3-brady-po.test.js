// G3 — "Create Brady PO" from an approved Sales PO was REMOVED in round 28
// (R1: the module makes only Purchase POs to Brady; the customer, customer PO
// and selling price are on the Purchase PO itself). The 20 G3 tests of the
// previous round are replaced by these checks:
//   - POST /:id/create-purchase no longer exists (404 for everyone), nothing made
//   - OLD records that were linked (Sales PO <-> Brady PO) still open, with
//     the link shown both ways, and the old Sales PO is read-only.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
let A, B, C;
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ctrl = () => require("../../controllers/purchase_order_controller");

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] });
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] G3", JSON.stringify(S.guardReport()));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("G3 REMOVED (R1)", () => {
  test("the controller no longer has createPurchaseFromSales / purchaseLinesFrom", () => {
    expect(ctrl().createPurchaseFromSales).toBeUndefined();
    expect(ctrl().purchaseLinesFrom).toBeUndefined();
  });

  test("POST /:id/create-purchase -> 404 for every role, on an approved old Sales PO; nothing made", async () => {
    const old = await S.insertSalesPo(A, { status: "approved" });
    const before = await PurchaseOrder().countDocuments({});
    for (const u of ["admin", "maker", "full", "approver", "viewer"]) {
      expect((await A.users[u].api.post(`${P}/${old._id}/create-purchase`, {})).status).toBe(404);
    }
    expect(await PurchaseOrder().countDocuments({})).toBe(before);
    expect((await PurchaseOrder().findById(old._id).lean()).linked_purchase_po).toBeUndefined();
  });

  test("an OLD linked pair (Sales PO <-> Brady PO) still opens with the link both ways; the Sales PO is read-only", async () => {
    const sales = await S.insertSalesPo(A, { status: "approved", number: "SPO-2025-0042" });
    const brady = await PurchaseOrder().create({
      tenant_id: A.tenantId, type: "purchase", division: "brady", po_number: "PPO-2025-0042", status: "draft",
      supplier: { name: "Brady" }, created_by: A.users.maker.id, source_sales_po: sales._id,
      items: [{ item_id: A.items.I1._id, item_code: "I1-A", name: "I1 Label A", qty: 2, cost_price: 100, list_price: 160, selling_price: 160, rate: 100, amount: 200 }],
      totals: { subtotal: 200, grand_total: 200 },
    });
    await PurchaseOrder().updateOne({ _id: sales._id }, { $set: { linked_purchase_po: brady._id } });
    const s = (await A.users.viewer.api.get(`${P}/${sales._id}`)).body;
    const b = (await A.users.viewer.api.get(`${P}/${brady._id}`)).body;
    expect(s.linked_purchase_po).toMatchObject({ _id: String(brady._id), po_number: "PPO-2025-0042", type: "purchase" });
    expect(b.source_sales_po).toMatchObject({ _id: String(sales._id), po_number: "SPO-2025-0042", type: "sales" });
    // read-only: edit / submit / status / WhatsApp / customer PO file -> 400
    expect((await A.users.maker.api.put(`${P}/${sales._id}`, { customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] })).status).toBe(400);
    expect((await A.users.admin.api.post(`${P}/${sales._id}/status`, { status: "sent" })).status).toBe(400);
    expect((await A.users.maker.api.upload(`${P}/${sales._id}/whatsapp`, { file: Buffer.from("%PDF-1.4"), fields: { to: "9123456789" } })).status).toBe(400);
    // the old Brady PO draft follows the new flow (submit -> pending).
    // Round 29 (S4): it has no customer, so submit first asks for one.
    const noCustomer = await A.users.maker.api.post(`${P}/${brady._id}/submit`, {});
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.field).toBe("customer");
    await PurchaseOrder().updateOne({ _id: brady._id }, { $set: { customer: A.customers.c1._id, customer_snapshot: { name: A.customers.c1.company } } });
    const sub = await A.users.maker.api.post(`${P}/${brady._id}/submit`, {});
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe("pending_approval");
  });

  test("Tenant C (add-on off) -> 403; other company's id -> 404", async () => {
    const old = await S.insertSalesPo(A, { status: "approved" });
    expect((await C.users.admin.api.post(`${P}/${old._id}/create-purchase`, {})).status).toBe(403);
    expect((await B.users.admin.api.get(`${P}/${old._id}`)).status).toBe(404);
  });
});
