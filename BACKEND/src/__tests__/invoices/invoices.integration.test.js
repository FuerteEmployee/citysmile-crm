// Invoices — INTEGRATION: permissions (every tenant), tenant isolation (every
// ordered pair of the six tenants), payments / credit notes / estimates links,
// status flow, overdue, customer delete. Expected-behaviour convention: a failing
// test is a finding.
const mongoose = require("mongoose");
const { startInvoiceApi, stop } = require("../../testUtils/invoiceHarness");
const { TENANTS } = require("../../testUtils/invoiceSeed");

jest.setTimeout(300000);

let H, S, Invoice, Payment, CreditNote;
beforeAll(async () => {
  H = await startInvoiceApi();
  S = H.seed;
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
  CreditNote = require("../../models/CreditNote");
  // One open credit note + one payment per tenant, for the isolation checks.
  for (const T of S.list) {
    T.creditNote = await CreditNote.create({ client: T.customers.guj._id, number: `CN-${T.key}`, subtotal: 500, total: 500, tenant_id: T.tenantId });
    T.payment = await Payment.create({ invoice: T.invoice._id, amount: 1, paymentmode: "Bank", tenant_id: T.tenantId });
  }
});
afterAll(stop);

const KEYS = TENANTS.map((t) => [t.label, t.key]);
const PAIRS = TENANTS.flatMap((a) => TENANTS.filter((b) => b.key !== a.key).map((b) => [`${a.label} -> ${b.label}`, a.key, b.key]));
const body = (T, extra = {}) => ({ client: String(T.customers.guj._id), items: [{ description: "W", qty: 1, rate: 100, tax: 18 }], ...extra });

describe.each(KEYS)("[%s] permissions", (_l, k) => {
  let T, viewer;
  beforeAll(() => { T = S[k]; viewer = H.as(T.viewer); });
  test("view-only staff can list invoices (200)", async () => expect((await viewer.get("/api/invoices")).status).toBe(200));
  test("view-only staff CANNOT create (403)", async () => expect((await viewer.post("/api/invoices", body(T))).status).toBe(403));
  test("view-only staff CANNOT edit (403)", async () => {
    expect((await viewer.put(`/api/invoices/${T.invoice._id}`, { adminnote: "hacked by viewer" })).status).toBe(403);
  });
  test("view-only staff CANNOT import (403)", async () => {
    expect((await viewer.post("/api/invoices/import", [{ "Voucher Number": `V-${k}`, "Party Name": T.customers.guj.company, Rate: 1 }])).status).toBe(403);
  });
  test("view-only staff CANNOT delete (403)", async () => {
    const inv = await Invoice.create({ client: T.customers.guj._id, number: `VD-${k}`, tenant_id: T.tenantId });
    expect((await viewer.del(`/api/invoices/${inv._id}`)).status).toBe(403);
  });
  test("view-only staff CANNOT bulk delete (403)", async () => {
    const inv = await Invoice.create({ client: T.customers.guj._id, number: `VBD-${k}`, tenant_id: T.tenantId });
    expect((await viewer.post("/api/invoices/bulk-delete", { ids: [String(inv._id)] })).status).toBe(403);
  });
  test("view-only staff CANNOT create a credit note (403)", async () => {
    const r = await viewer.post("/api/credit-notes", { client: String(T.customers.guj._id), items: [{ description: "x", qty: 1, rate: 1 }] });
    expect(r.status).toBe(403);
  });
  test("view-only staff CANNOT apply a credit note (403)", async () => {
    const inv = await Invoice.create({ client: T.customers.guj._id, number: `VCN-${k}`, tenant_id: T.tenantId, total: 100, subtotal: 100 });
    expect((await viewer.post(`/api/credit-notes/${T.creditNote._id}/apply`, { invoiceId: String(inv._id), amount: 1 })).status).toBe(403);
  });
  test("view-only staff (no Payments permission) cannot record a payment (403)", async () => {
    expect((await viewer.post("/api/payments", { invoice: String(T.invoice._id), amount: 1 })).status).toBe(403);
  });
  test("full editor can create, edit, pay and delete", async () => {
    const ed = H.as(T.editor);
    const c = await ed.post("/api/invoices", body(T));
    expect(c.status).toBe(201);
    expect((await ed.put(`/api/invoices/${c.body._id}`, { adminnote: "ok" })).status).toBe(200);
    expect((await ed.post("/api/payments", { invoice: c.body._id, amount: 1, paymentmode: "Bank" })).status).toBe(201);
    const c2 = await ed.post("/api/invoices", body(T));
    expect((await ed.del(`/api/invoices/${c2.body._id}`)).status).toBe(200);
  });
  test("no-permission staff gets 403 'Forbidden: no View permission for Invoices'", async () => {
    const r = await H.as(T.nobody).get("/api/invoices");
    expect(r.status).toBe(403);
    expect(r.body.message).toBe("Forbidden: no View permission for Invoices");
  });
  test("'View (Own)' staff sees only invoices where they are the sale agent", async () => {
    await Invoice.create({ client: T.customers.guj._id, number: `OWN-${k}`, tenant_id: T.tenantId, created_by: T.own.id });
    const r = await H.as(T.own).get("/api/invoices");
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((i) => String(i.created_by) === String(T.own.id))).toBe(true);
  });
  test("'View (Own)' staff can see an invoice they just created themselves", async () => {
    const own = H.as(T.own);
    const c = await own.post("/api/invoices", body(T));
    expect(c.status).toBe(201);
    expect((await own.get(`/api/invoices/${c.body._id}`)).status).toBe(200);
  });
  test("bank-details API: allowed only for Rudraverse + Ekagra", async () => {
    const r = await H.as(T.admin).get("/api/bank-details");
    expect(r.status).toBe(T.flags.bank ? 200 : 403);
  });
  test("sidebar: /admin/invoices is labelled 'Sales' for Rudraverse, 'Invoices' (in group Sales) otherwise", async () => {
    const r = await H.as(T.admin).get("/api/mainsidebar");
    const rows = Array.isArray(r.body) ? r.body : r.body.data || r.body.items || [];
    const inv = rows.find((x) => x.url === "/admin/invoices");
    expect(inv).toBeTruthy();
    if (T.flags.pilot) expect(inv.title).toBe("Sales");
    else {
      expect(inv.title).toBe("Invoices");
      expect(inv.group).toBe("Sales");
    }
  });
});

describe.each(PAIRS)("isolation %s", (_l, a, b) => {
  let A, B, api;
  beforeAll(() => { A = S[a]; B = S[b]; api = H.as(A.admin); });
  test("cannot GET other company's invoice (404)", async () => expect((await api.get(`/api/invoices/${B.invoice._id}`)).status).toBe(404));
  test("cannot PUT other company's invoice (404)", async () => {
    expect((await api.put(`/api/invoices/${B.invoice._id}`, { adminnote: `pwned by ${a}` })).status).toBe(404);
  });
  test("cannot DELETE other company's invoice (404)", async () => {
    const inv = await Invoice.create({ client: B.customers.guj._id, number: `DEL-${a}-${b}`, tenant_id: B.tenantId });
    const r = await api.del(`/api/invoices/${inv._id}`);
    expect(r.status).toBe(404);
    expect(await Invoice.exists({ _id: inv._id })).toBeTruthy();
  });
  test("bulk delete skips other company's invoice", async () => {
    const inv = await Invoice.create({ client: B.customers.guj._id, number: `BDEL-${a}-${b}`, tenant_id: B.tenantId });
    await api.post("/api/invoices/bulk-delete", { ids: [String(inv._id)] });
    expect(await Invoice.exists({ _id: inv._id })).toBeTruthy();
  });
  test("list + search never return other company's rows", async () => {
    const r = await api.get(`/api/invoices?page=1&limit=500&search=${encodeURIComponent(`Secret ${B.label}`)}`);
    expect(r.body.total).toBe(0);
  });
  test("cannot read other company's invoice payments", async () => {
    const r = await api.get(`/api/payments/invoice/${B.invoice._id}`);
    expect(Array.isArray(r.body) ? r.body.length : 0).toBe(0);
  });
  test("cannot read other company's payments via /payments/customer/:clientId", async () => {
    const r = await api.get(`/api/payments/customer/${B.customers.guj._id}`);
    expect(Array.isArray(r.body) ? r.body.length : 0).toBe(0);
  });
  test("cannot record a payment on other company's invoice", async () => {
    const r = await api.post("/api/payments", { invoice: String(B.invoice._id), amount: 0.01, paymentmode: "Bank" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("cannot edit other company's payment", async () => {
    const r = await api.put(`/api/payments/${B.payment._id}`, { note: `edited by ${a}` });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("cannot read other company's credit note (404)", async () => {
    expect((await api.get(`/api/credit-notes/${B.creditNote._id}`)).status).toBe(404);
  });
  test("cannot apply own credit note to other company's invoice", async () => {
    const r = await api.post(`/api/credit-notes/${A.creditNote._id}/apply`, { invoiceId: String(B.invoice._id), amount: 0.01 });
    expect(r.status).toBe(404);
  });
  test("cannot create an invoice for other company's customer", async () => {
    const r = await api.post("/api/invoices", body(B, { number: `X-${a}-${b}` }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("same invoice number INV-SHARED-1 exists independently in both companies", async () => {
    expect(await Invoice.exists({ tenant_id: A.tenantId, number: "INV-SHARED-1" })).toBeTruthy();
    expect(await Invoice.exists({ tenant_id: B.tenantId, number: "INV-SHARED-1" })).toBeTruthy();
  });
});

describe("Cross-module flows (BeOnTime)", () => {
  let T, api;
  beforeAll(() => { T = S.A; api = H.as(T.admin); });
  const mk = async (extra = {}) => (await api.post("/api/invoices", body(T, extra))).body;

  test("status flow: unpaid -> partial -> paid -> delete one -> partial -> delete all -> unpaid", async () => {
    const inv = await mk();
    const st = async () => (await Invoice.findById(inv._id)).status;
    const p1 = (await api.post("/api/payments", { invoice: inv._id, amount: 50, paymentmode: "Bank" })).body;
    expect(await st()).toBe("partially_paid");
    const p2 = (await api.post("/api/payments", { invoice: inv._id, amount: 68, paymentmode: "Bank" })).body;
    expect(await st()).toBe("paid");
    await api.del(`/api/payments/${p2._id}`);
    expect(await st()).toBe("partially_paid");
    await api.del(`/api/payments/${p1._id}`);
    expect(await st()).toBe("unpaid");
  });
  test("credit note of customer X cannot be applied to customer Y's invoice", async () => {
    const inv = await mk({ client: String(T.customers.mah._id) });
    const cn = await CreditNote.create({ client: T.customers.guj._id, number: "CN-XY", subtotal: 50, total: 50, tenant_id: T.tenantId });
    const r = await api.post(`/api/credit-notes/${cn._id}/apply`, { invoiceId: inv._id, amount: 10 });
    expect(r.status).toBe(400);
  });
  test("deleting the 'Credit Note' payment gives the credit back to the credit note", async () => {
    const inv = await mk();
    const cn = await CreditNote.create({ client: T.customers.guj._id, number: "CN-BACK", subtotal: 50, total: 50, tenant_id: T.tenantId });
    await api.post(`/api/credit-notes/${cn._id}/apply`, { invoiceId: inv._id, amount: 50 });
    const p = await Payment.findOne({ invoice: inv._id, paymentmode: "Credit Note" });
    await api.del(`/api/payments/${p._id}`);
    const after = await CreditNote.findById(cn._id);
    expect(after.remaining_amount).toBe(50);
  });
  test("estimate convert copies tax figures (total_tax, tax_type, CGST/SGST)", async () => {
    const Estimate = require("../../models/Estimate");
    const est = await Estimate.create({ client: T.customers.mah._id, number: "EST-T1", subtotal: 1000, total: 1180, total_tax: 180,
      items: [{ description: "Widget", qty: 2, rate: 500, tax: 18 }], tenant_id: T.tenantId, currency: "INR" });
    const r = await api.post(`/api/estimates/${est._id}/convert-to-invoice`, {});
    expect(r.body.total_tax).toBe(180);
    expect(r.body.tax_type).toBe("IGST");
  });
  test("estimate cannot be converted twice", async () => {
    const Estimate = require("../../models/Estimate");
    const est = await Estimate.create({ client: T.customers.guj._id, number: "EST-T2", subtotal: 1, total: 1, tenant_id: T.tenantId });
    await api.post(`/api/estimates/${est._id}/convert-to-invoice`, {});
    const r2 = await api.post(`/api/estimates/${est._id}/convert-to-invoice`, {});
    expect(r2.status).toBeGreaterThanOrEqual(400);
  });
  test("an invoice whose due date has passed becomes 'overdue' (no job does this)", async () => {
    const inv = await mk({ date: "2026-01-01", duedate: "2026-01-31" });
    const g = await api.get(`/api/invoices/${inv._id}`);
    expect(g.body.status).toBe("overdue");
  });
  test("customer with invoices cannot be deleted", async () => {
    const r = await api.del(`/api/clients/${T.customers.guj._id}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("status cards: statusAgg totals equal sum of invoice totals per bucket", async () => {
    const r = await api.get("/api/invoices?page=1&limit=500");
    const all = await Invoice.find({ tenant_id: T.tenantId }).lean();
    const sum = all.filter((i) => ["unpaid", "sent", "sent_later"].includes(i.status)).reduce((s, i) => s + i.total, 0);
    const unpaid = r.body.statusAgg.find((x) => x.status === "unpaid");
    expect(Math.round(unpaid.total * 100)).toBe(Math.round(sum * 100));
  });
});
