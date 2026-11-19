// Invoices — POSITIVE: happy paths through the real /api routes (normal admin, tenant A).
// Expected-behaviour convention: a failing test is a finding.
const { startInvoiceApi, stop, r2 } = require("../../testUtils/invoiceHarness");
const { TENANTS } = require("../../testUtils/invoiceSeed");

jest.setTimeout(120000);

let H, Invoice, Payment;
beforeAll(async () => {
  H = await startInvoiceApi();
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
});
afterAll(stop);

describe.each(TENANTS.map((t) => [t.label, t.key]))("[%s]", (_label, tkey) => {
let T, api;
beforeAll(() => { T = H.seed[tkey]; api = H.as(T.admin); });
// Ekagra sells from Bihar, so a Gujarat buyer is inter-state (IGST) for it only.
const gujType = () => (T.flags.ekagra ? "IGST" : "GST");

const cid = (k = "guj") => String(T.customers[k]._id);
const item = (o = {}) => ({ description: "Widget", qty: 2, rate: 500, tax: 18, ...o });
const create = (body) => api.post("/api/invoices", { client: cid(), items: [item()], ...body });

describe("Create", () => {
  test("only Customer + 1 item (qty 1, rate 100, no tax) -> 201, total 100.00, auto number, unpaid", async () => {
    const r = await api.post("/api/invoices", { client: cid(), items: [{ description: "One", qty: 1, rate: 100 }] });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(100);
    expect(r.body.status).toBe("unpaid");
    expect(r.body.number).toMatch(/^INV-\d+$/);
    const db = await Invoice.findById(r.body._id).lean();
    expect(db.total).toBe(100);
    expect(String(db.tenant_id)).toBe(String(T.tenantId));
  });

  test("auto numbers are sequential (INV-n, INV-n+1)", async () => {
    const a = await create({ auto_number: true });
    const b = await create({ auto_number: true });
    const na = Number(a.body.number.replace("INV-", ""));
    expect(b.body.number).toBe(`INV-${na + 1}`);
  });

  test("ALL fields are saved as sent", async () => {
    const body = {
      client: cid("mah"), project: String(T.projects.mah._id), number: "ALL-1",
      date: "2026-10-01", duedate: "2026-10-31", voucherType: "Sales", gstin: "27bbbbb2222b1z5", vat: "VAT-9",
      partyAddress: "2 Marine Drive\nMumbai", partyGroup: "Sundry Debtors", termsOfPayment: "30 days",
      currency: "USD", created_by: String(T.sales.id), salesPerson: "SalesA Test", branch: T.branches[0].name,
      discount_percent: 10, adjustment: -0.5, adminnote: "admin only", notes: "client note", terms: "T&C",
      items: [
        { description: "Widget", itemHSN: "8471", itemBatch: "B1", unit: "Nos", qty: 2, rate: 500, freight_charge: 10, gstPercentage: 18, tax: 18, tax_name: "GST 18" },
        { description: "Gadget", itemHSN: "8472", itemBatch: "B2", unit: "Box", qty: 1, rate: 99.99, freight_charge: 1, gstPercentage: 5, tax: 5 },
        { description: "Service Hour", itemHSN: "9983", itemBatch: "", unit: "Hr", qty: 3, rate: 33.33, freight_charge: 1, gstPercentage: 0, tax: 0 },
      ],
    };
    const r = await api.post("/api/invoices", body);
    expect(r.status).toBe(201);
    const db = await Invoice.findById(r.body._id).lean();
    // Branch / Sales Person are pilot-only fields: other companies cannot set them.
    const pilotOnly = T.flags.pilot ? ["salesPerson", "branch"] : [];
    if (!T.flags.pilot) { expect(db.salesPerson || "").toBe(""); expect(db.branch || "").toBe(""); }
    for (const k of ["number", "voucherType", "vat", "partyGroup", "termsOfPayment", "currency", ...pilotOnly, "adminnote", "notes", "terms", "discount_percent", "adjustment"]) {
      expect([k, db[k]]).toEqual([k, body[k]]);
    }
    expect(db.gstin).toBe("27BBBBB2222B1Z5");
    expect(db.partyAddress).toBe("2 Marine Drive\nMumbai");
    expect(String(db.project)).toBe(body.project);
    expect(String(db.created_by)).toBe(body.created_by);
    expect(db.items.map((i) => i.itemHSN)).toEqual(["8471", "8472", "9983"]);
    expect(db.tax_type).toBe("IGST");
    // subtotal 1000 + 99.99 + 99.99 = 1199.98; freight 12; tax (1010*18% + 100.99*5%)*0.9 = 168.17... ; discount 119.998
    const sub = 1000 + 99.99 + 99.99;
    const tax = (1010 * 0.18 + 100.99 * 0.05) * 0.9;
    const expected = r2(sub + 12 + tax - sub * 0.1 - 0.5);
    expect(db.total).toBe(expected);
  });
});

describe("Money: API total = DB total = hand-computed", () => {
  const cases = [
    ["2 x 500 + 18% (Gujarat)", () => ({ items: [item()] }), 1180, "guj"],
    ["2 x 500 + 18% (Maharashtra)", () => ({ client: cid("mah"), items: [item()] }), 1180, "IGST"],
    ["freight 1% default", () => ({ items: [item({ freight_charge: 10 })] }), 1191.8, "guj"],
    ["discount 10%", () => ({ items: [item()], discount_percent: 10 }), 1062, "guj"],
    ["adjustment -0.50", () => ({ items: [item()], adjustment: -0.5 }), 1179.5, "guj"],
  ];
  test.each(cases)("%s", async (_n, body, total, type) => {
    const r = await create(body());
    if (type === "guj") type = gujType();
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(total);
    expect(r.body.tax_type).toBe(type);
    const db = await Invoice.findById(r.body._id).lean();
    expect(db.total).toBe(total);
  });
  test("total_tax stored on the invoice = tax actually inside the total (2x500 @18% -> 180.00)", async () => {
    const r = await create({ items: [item()] });
    const db = await Invoice.findById(r.body._id).lean();
    expect(db.total_tax).toBe(180);
  });
  test("CGST/SGST stored = 90.00 each for a home-state buyer (Gujarat; Bihar for Ekagra)", async () => {
    const r = await create({ client: cid(T.flags.ekagra ? "bihar" : "guj"), items: [item()] });
    expect(r.body.total_cgst).toBe(90);
    expect(r.body.total_sgst).toBe(90);
  });
  test("line amount stored = qty x rate when the client does not send it", async () => {
    const r = await create({ items: [item()] });
    expect(r.body.items[0].amount).toBe(1000);
  });
  test("currency defaults to the company default (INR), not USD, when not sent", async () => {
    const r = await create({});
    expect(r.body.currency).toBe("INR");
  });
});

describe("Status at create + payments", () => {
  test("status partially_paid + POST payment 40% -> partially_paid, payment row exists", async () => {
    // Status follows payments: the invoice is saved unpaid, the payment sets it.
    const r = await create({});
    const p = await api.post("/api/payments", { invoice: r.body._id, amount: 472, paymentmode: "Bank" });
    expect(p.status).toBe(201);
    expect((await Invoice.findById(r.body._id)).status).toBe("partially_paid");
    expect(await Payment.countDocuments({ invoice: r.body._id })).toBe(1);
  });
  test("status paid + payment = total -> paid", async () => {
    const r = await create({});
    await api.post("/api/payments", { invoice: r.body._id, amount: 1180, paymentmode: "Bank" });
    expect((await Invoice.findById(r.body._id)).status).toBe("paid");
  });
  test("draft is saved as draft", async () => {
    const r = await create({ status: "draft" });
    expect(r.body.status).toBe("draft");
  });
  test("GET /:id shows total_paid and credits_applied", async () => {
    const r = await create({});
    await api.post("/api/payments", { invoice: r.body._id, amount: 100.55, paymentmode: "Cash" });
    const g = await api.get(`/api/invoices/${r.body._id}`);
    expect(g.status).toBe(200);
    expect(g.body.total_paid).toBe(100.55);
    expect(g.body.credits_applied).toBe(0);
    expect(g.body.status).toBe("partially_paid");
  });
});

describe("Edit", () => {
  test("PUT every editable field is saved and totals recomputed", async () => {
    const r = await create({});
    const u = await api.put(`/api/invoices/${r.body._id}`, {
      voucherType: "Tax Invoice", partyGroup: "G2", termsOfPayment: "15 days", adminnote: "n2", notes: "c2",
      items: [item({ qty: 1 })], discount_percent: 0, adjustment: 1,
    });
    expect(u.status).toBe(200);
    expect(u.body.total).toBe(591);
    expect(u.body.voucherType).toBe("Tax Invoice");
  });
  test("PUT {status:'cancelled'} only keeps total and items", async () => {
    const r = await create({});
    const u = await api.put(`/api/invoices/${r.body._id}`, { status: "cancelled" });
    expect(u.status).toBe(200);
    expect(u.body.total).toBe(1180);
    expect(u.body.items).toHaveLength(1);
  });
});

describe("List, search, buckets, branches", () => {
  let mark;
  beforeAll(async () => {
    mark = `SRCH${Date.now()}`;
    await create({ number: `${mark}-1`, status: "sent", branch: `${T.branches[1].name}`, gstin: "24ZZZZZ0000Z1Z5",
      items: [item({ description: `Item ${mark}`, itemHSN: `H${mark}` })] });
    // "recorded" only comes from import now; branch is set the way an import sets it.
    const rec = await create({ number: `${mark}-2` });
    await Invoice.updateOne({ _id: rec.body._id }, { status: "recorded" });
    await Invoice.updateOne({ number: `${mark}-1`, tenant_id: T.tenantId }, { branch: `${T.branches[1].name}` });
  });
  test("paginated list returns data/total/pages/statusAgg", async () => {
    const r = await api.get("/api/invoices?page=1&limit=10");
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeLessThanOrEqual(10);
    expect(r.body).toHaveProperty("statusAgg");
  });
  test.each([["number", (m) => `${m}-1`], ["item", (m) => `Item ${m}`], ["HSN", (m) => `H${m}`], ["GSTIN", () => "24ZZZZZ0000Z1Z5"]])(
    "search by %s", async (_k, q) => {
      const r = await api.get(`/api/invoices?page=1&limit=50&search=${encodeURIComponent(q(mark))}`);
      expect(r.body.data.some((i) => i.number === `${mark}-1`)).toBe(true);
    });
  test("search by party name", async () => {
    const r = await api.get(`/api/invoices?page=1&limit=500&search=${encodeURIComponent("Gujarat Traders")}`);
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.data.every((i) => i.client.company === T.customers.guj.company)).toBe(true);
  });
  test("search 'paid' finds recorded invoices", async () => {
    const r = await api.get("/api/invoices?page=1&limit=500&search=paid");
    expect(r.body.data.some((i) => i.number === `${mark}-2`)).toBe(true);
  });
  test("status bucket unpaid includes sent", async () => {
    const r = await api.get("/api/invoices?page=1&limit=500&status=unpaid");
    expect(r.body.data.some((i) => i.number === `${mark}-1`)).toBe(true);
  });
  test("branch filter", async () => {
    const r = await api.get(`/api/invoices?page=1&limit=500&branch=${encodeURIComponent(`${T.branches[1].name}`)}`);
    expect(r.body.data.every((i) => i.branch === `${T.branches[1].name}`)).toBe(true);
    expect(r.body.total).toBeGreaterThan(0);
  });
  test("GET /branches lists distinct invoice branches", async () => {
    const r = await api.get("/api/invoices/branches");
    expect(r.body).toContain(`${T.branches[1].name}`);
  });
  test("client filter (customer Invoices tab)", async () => {
    const r = await api.get(`/api/invoices?client=${cid("mah")}`);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.every((i) => String(i.client._id) === cid("mah"))).toBe(true);
  });
  test("next-number gives INV-<n>", async () => {
    const r = await api.get("/api/invoices/next-number");
    expect(r.body.number).toMatch(/^INV-\d+$/);
  });
});

describe("Delete / bulk delete", () => {
  test("delete an unpaid invoice", async () => {
    const r = await create({});
    const d = await api.del(`/api/invoices/${r.body._id}`);
    expect(d.status).toBe(200);
    expect(await Invoice.findById(r.body._id)).toBeNull();
  });
  test("bulk delete mix -> 'Deleted 1 invoice(s). 1 skipped (has recorded payments).'", async () => {
    const a = await create({});
    const b = await create({});
    await api.post("/api/payments", { invoice: b.body._id, amount: 1, paymentmode: "Cash" });
    const r = await api.post("/api/invoices/bulk-delete", { ids: [a.body._id, b.body._id] });
    expect(r.body.message).toBe("Deleted 1 invoice(s). 1 skipped (has recorded payments).");
  });
});

describe("Import", () => {
  test("3 invoices: one with 2 item rows, one DD-MM-YYYY date, one new customer", async () => {
    const rows = [
      { "Voucher Number": "IMP-1", "Bill Date": "2026-10-01", "Party Name": `${T.customers.guj.company}`, "Item Name": "Widget", Quantity: 2, Rate: 500, "GST percentage": 18 },
      { "Voucher Number": "IMP-1", "Bill Date": "2026-10-01", "Party Name": `${T.customers.guj.company}`, "Item Name": "Gadget", Quantity: 1, Rate: 100, "GST percentage": 5 },
      { "Voucher Number": "IMP-2", "Bill Date": "15-09-2026", "Party Name": `${T.customers.mah.company}`, "Item Name": "Widget", Quantity: 1, Rate: 1000, "Freight %": 1, "GST percentage": 18, Status: "Partially Paid" },
      { "Voucher Number": "IMP-3", "Bill Date": "2026-10-02", "Party Name": "Brand New Customer", "Item Name": "Widget", Quantity: 1, Rate: 10 },
    ];
    const r = await api.post("/api/invoices/import", rows);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(3);
    const i1 = await Invoice.findOne({ tenant_id: T.tenantId, number: "IMP-1" }).lean();
    expect(i1.items).toHaveLength(2);
    expect(i1.total).toBe(1000 + 100 + 180 + 5);
    const i2 = await Invoice.findOne({ tenant_id: T.tenantId, number: "IMP-2" }).lean();
    expect(i2.date.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(i2.items[0].freight_charge).toBe(10);
    expect(i2.total).toBe(1000 + 10 + 181.8);
    expect(i2.status).toBe("partially_paid");
    expect(i2.tax_type).toBe("IGST");
    const Client = require("../../models/Client");
    const nc = await Client.findOne({ tenant_id: T.tenantId, company: /brand new customer/i }).lean();
    expect(nc).not.toBeNull();
  });
  test("imported invoice stores total_tax (tax inside the total)", async () => {
    const i1 = await Invoice.findOne({ tenant_id: T.tenantId, number: "IMP-1" }).lean();
    expect(i1.total_tax).toBe(185);
  });
  test("imported new customer keeps the name as typed (not lower-cased)", async () => {
    const Client = require("../../models/Client");
    const nc = await Client.findOne({ tenant_id: T.tenantId, company: /brand new customer/i }).lean();
    expect(nc.company).toBe("Brand New Customer");
  });
  test("duplicate voucher number is renamed (1)", async () => {
    const r = await api.post("/api/invoices/import", [{ "Voucher Number": "IMP-1", "Bill Date": "2026-11-01", "Party Name": `${T.customers.guj.company}`, Rate: 1 }]);
    expect(r.body.renamed).toBe(1);
    expect(await Invoice.exists({ tenant_id: T.tenantId, number: "IMP-1(1)" })).toBeTruthy();
  });
});

describe("Credit note apply + estimate convert", () => {
  test("apply credit note -> Payment mode 'Credit Note', status partially_paid, credits_applied shows", async () => {
    const CreditNote = require("../../models/CreditNote");
    const inv = await create({});
    const cn = await CreditNote.create({ client: T.customers.guj._id, number: "CN-1", subtotal: 500, total: 500, tenant_id: T.tenantId });
    const r = await api.post(`/api/credit-notes/${cn._id}/apply`, { invoiceId: inv.body._id, amount: 300 });
    expect(r.status).toBeLessThan(300);
    const p = await Payment.findOne({ invoice: inv.body._id }).lean();
    expect(p.paymentmode).toBe("Credit Note");
    expect((await Invoice.findById(inv.body._id)).status).toBe("partially_paid");
    const g = await api.get(`/api/invoices/${inv.body._id}`);
    expect(g.body.credits_applied).toBe(300);
    const byInv = await api.get(`/api/credit-notes/invoice/${inv.body._id}`);
    expect(byInv.body[0].applied_amount).toBe(300);
  });
  test("estimate -> convert to invoice: same company, appears in list, same total", async () => {
    const Estimate = require("../../models/Estimate");
    const est = await Estimate.create({ client: T.customers.guj._id, number: "EST-1", subtotal: 1000, total: 1180, total_tax: 180,
      items: [{ description: "Widget", qty: 2, rate: 500, tax: 18 }], tenant_id: T.tenantId });
    const r = await api.post(`/api/estimates/${est._id}/convert-to-invoice`, {});
    expect(r.status).toBe(201);
    expect(String(r.body.tenant_id)).toBe(String(T.tenantId));
    expect(r.body.total).toBe(1180);
    const list = await api.get("/api/invoices");
    expect(list.body.some((i) => i._id === r.body._id)).toBe(true);
  });
});

});
