// Full business flow in ONE test — round 28 (Brady flow, R1/R4/R6):
// PO items by Excel -> the customer's PO is entered as a PURCHASE PO (customer,
// customer PO no. / date / file, selling price raised) -> lowering refused ->
// submit -> pending (always) -> socket event to the approver -> Yes -> print
// data (F1) -> WhatsApp (mocked) to the Brady number -> sent; History,
// Activity Log, WhatsAppInbox rows. (The previous round's flow went through a
// Sales PO and "Create Brady PO" — both removed by R1.)
// The price-list (F2) + proforma flow is in brady-flow.test.js.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
let T;
const ActivityLog = () => require("../../models/ActivityLog");
const WhatsAppInbox = () => require("../../models/WhatsAppInbox");
const Item = () => require("../../models/Item");
const Client = () => require("../../models/Client");
const PDF = Buffer.from("%PDF-1.4 brady po");
const BRADY = "9999999999";

beforeAll(async () => {
  await S.startStack();
  T = await S.seedTenant("T");
  process.env.PURCHASE_ORDERS_TENANT_IDS = String(T.tenantId);
});

afterAll(async () => {
  console.log("[guard] FLOW", JSON.stringify(S.guardReport()), "mocked wa calls", S.rec.whatsapp.length, "mocked uploads", S.rec.cloudinary.length);
  expect(S.rec.blockedNetwork).toEqual([]);
  // only mocked calls, all to the fake Brady number / mocked file host
  expect(S.rec.whatsapp.filter((c) => c.mobile).every((c) => c.mobile === BRADY)).toBe(true);
  expect(S.rec.cloudinary.every((c) => c.folder === "purchase_orders")).toBe(true);
  await S.stopStack();
});

test("customer PO -> Purchase PO (customer + raised price) -> pending -> approver Yes -> print data -> WhatsApp to Brady -> sent", async () => {
  const { admin, maker, approver, pricer } = T.users;
  const crmItemsBefore = await Item().countDocuments({});

  // 0. Settings: Brady's WhatsApp number (fake); PO items uploaded from Excel.
  const cur = (await admin.api.get(`${P}/settings`)).body;
  expect(cur.rules.purchase.price_floor).toBe(true);
  expect((await admin.api.put(`${P}/settings`, { supplier: { ...cur.supplier, whatsapp: BRADY } })).status).toBe(200);
  const sheet = [{ item_code: "BRD-M21", name: "M21 Cartridge", hsn: "84439959", unit: "Nos", tax_rate: "18", master_price: "100", end_customer_price: "160" }];
  expect((await pricer.api.post(`${P}/items/import/preview`, { rows: sheet })).body.summary).toEqual({ new: 1, update: 0, unchanged: 0, error: 0 });
  expect((await pricer.api.post(`${P}/items/import`, { rows: sheet })).body.created).toBe(1);
  expect(await Item().countDocuments({})).toBe(crmItemsBefore); // nothing added to CRM Items
  const item = (await maker.api.get(`${P}/items?active=true&search=BRD-M21`)).body.data[0];
  const acme = await Client().create({ company: "Acme Ltd", tenant_id: T.tenantId, phonenumber: "9876500000" });

  // 1-3. Acme's PO "ACME-PO-778" is entered as a Purchase PO; lowering is refused, raised to 175.
  const base = { type: "purchase", division: "brady", customer: String(acme._id), customer_po_number: "ACME-PO-778", customer_po_date: "2026-10-20" };
  const low = await maker.api.post(P, { ...base, items: [{ item_id: item._id, qty: 2, selling_price: 159.99 }], submit: true });
  expect(low.status).toBe(400);
  const ioMark = S.rec.io.length;
  const created = await maker.api.post(P, { ...base, items: [{ item_id: item._id, qty: 2, selling_price: 175 }], submit: true });
  expect(created.status).toBe(201);
  const po = created.body;
  expect(po).toMatchObject({ status: "pending_approval", customer_po_number: "ACME-PO-778", price_level: "end_user" });
  expect(po.approval.reasons).toEqual(["Line 1 (M21 Cartridge): Price raised from 160 to 175"]);
  // cost = MDP 100 (printed), selling 175, margin 42.86 % / ₹150 (screen only)
  expect(po.items[0]).toMatchObject({ cost_price: 100, rate: 100, amount: 200, selling_price: 175, margin_pct: 42.86, margin_amount: 150 });
  const att = await maker.api.upload(`${P}/${po._id}/customer-po-file`, { file: PDF, filename: "ACME-PO-778.pdf" });
  expect(att.status).toBe(200);
  // before Yes: no PDF data, no WhatsApp
  expect((await maker.api.get(`${P}/${po._id}/print`)).status).toBe(400);
  expect((await maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF })).status).toBe(400);

  // 4. Approver gets the live event and says Yes.
  const toApprover = S.rec.io.slice(ioMark).filter((e) => e.room === String(approver.id) && e.event === "purchaseOrderApproval");
  expect(toApprover).toEqual([expect.objectContaining({ payload: expect.objectContaining({ event: "requested", poId: String(po._id), number: po.po_number }) })]);
  expect((await approver.api.get(`${P}/approvals/pending`)).body.map((p) => p._id)).toContain(po._id);
  const yes = await approver.api.post(`${P}/${po._id}/approve`, {});
  expect(yes.body.status).toBe("approved");
  expect(S.rec.io.slice(-1)[0]).toMatchObject({ room: String(maker.id), payload: { event: "approved" } });

  // 5. Print data (F1 PO PDF is built in the browser) -> WhatsApp (mocked) to Brady inside the 24 h window.
  const forPdf = (await maker.api.get(`${P}/${po._id}/print`)).body;
  expect(forPdf.po.items[0]).toMatchObject({ item_code: "BRD-M21", hsn: "84439959", rate: 100 });
  expect(forPdf.company).toBeDefined();
  await WhatsAppInbox().create({ tenant_id: T.tenantId, from: `91${BRADY}`, mobile: BRADY, direction: "in", message: "hi", received_at: new Date() });
  const file = `${po.po_number.replace(/\//g, "-")}.pdf`;
  const sent = await maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, filename: file });
  expect(sent.status).toBe(200);
  expect(sent.body.status).toBe("sent");
  expect(sent.body.whatsapp_log.slice(-1)[0]).toMatchObject({ to: BRADY, method: "document", status: "sent" });
  expect(S.rec.whatsapp.filter((c) => c.fn === "sendDocumentMessage").slice(-1)[0]).toMatchObject({ mobile: BRADY, filename: file });

  // History, Activity Log, WhatsAppInbox "out" row.
  const g = (await maker.api.get(`${P}/${po._id}`)).body;
  expect(g.history.map((h) => h.action)).toEqual(["created", "submitted", "customer_po_file", "approved", "whatsapp", "status:sent"]);
  const logs = await waitFor(async () => {
    const x = await ActivityLog().find({ tenant_id: T.tenantId, rel_type: "purchase_order" }).lean();
    return x.length >= 5 ? x : null;
  });
  expect(logs.map((l) => l.description)).toEqual(expect.arrayContaining([
    `Purchase PO ${po.po_number} created`,
    `Purchase PO ${po.po_number} sent for approval`,
    `Purchase PO ${po.po_number} customer PO attached — ACME-PO-778.pdf`,
    `Purchase PO ${po.po_number} approved`,
    `Purchase PO ${po.po_number} sent on WhatsApp — to ${BRADY}`,
  ]));
  const out = await waitFor(() => WhatsAppInbox().findOne({ tenant_id: T.tenantId, direction: "out", mobile: BRADY }).lean());
  expect(out).toMatchObject({ msg_type: "document", message: file, wa_message_id: "wamid.DOC" });

  // Afterwards: the approved PO keeps its prices when the master moves.
  await pricer.api.put(`${P}/items/${item._id}`, { end_customer_price: 190 });
  expect((await maker.api.get(`${P}/${po._id}`)).body.items[0]).toMatchObject({ list_price: 160, selling_price: 175 });
  // ...and a Sales PO / "Create Brady PO" no longer exist (R1).
  expect((await maker.api.post(P, { ...base, type: "sales", items: [{ item_id: item._id, qty: 1 }] })).status).toBe(400);
  expect((await maker.api.post(`${P}/${po._id}/create-purchase`, {})).status).toBe(404);
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
