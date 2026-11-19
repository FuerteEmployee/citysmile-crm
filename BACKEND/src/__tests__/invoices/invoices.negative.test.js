// Invoices — NEGATIVE: bad input for every field via POST/PUT, plus auth, ids,
// mass assignment, delete rules and import edge cases. Runs as the BeOnTime admin
// (the field handling is the same code for every tenant). Expected-behaviour
// convention: a failing test is a finding.
const mongoose = require("mongoose");
const { startInvoiceApi, stop } = require("../../testUtils/invoiceHarness");

jest.setTimeout(180000);

let H, S, api, Invoice, Payment, Client;
beforeAll(async () => {
  H = await startInvoiceApi();
  S = H.seed;
  api = H.as(S.A.admin);
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
  Client = require("../../models/Client");
});
// Records what the API really answered per test (status + message), so the report
// can show the actual result next to the expected one.
const actual = {};
afterAll(async () => {
  if (process.env.INVOICE_ACTUALS) require("fs").writeFileSync(process.env.INVOICE_ACTUALS, JSON.stringify(actual, null, 1));
  await stop();
});
const rec = (r) => {
  const name = expect.getState().currentTestName;
  (actual[name] = actual[name] || []).push({ status: r.status, message: r.body && r.body.message, total: r.body && r.body.total });
  return r;
};

const cid = (k = "guj") => String(S.A.customers[k]._id);
const item = (o = {}) => ({ description: "Widget", qty: 1, rate: 100, ...o });
let n = 0;
const create = (body) => api.post("/api/invoices", { client: cid(), number: `NEG-${++n}`, items: [item()], ...body }).then(rec);
const is4xx = (s) => s >= 400 && s < 500;

describe("Auth + ids", () => {
  test("no token -> 401", async () => expect((await H.anon.get("/api/invoices")).status).toBe(401));
  test("bad token -> 401", async () => expect((await H.as({ token: "bad.token.x" }).get("/api/invoices")).status).toBe(401));
  test.each(["get", "put", "del"])("%s /api/invoices/abc -> 400/404 (not 500)", async (m) => {
    const r = await api[m]("/api/invoices/abc", m === "put" ? { status: "paid" } : undefined).then(rec);
    expect(is4xx(r.status)).toBe(true);
  });
  test.each(["get", "put", "del"])("%s non-existent id -> 404 'Invoice not found'", async (m) => {
    const id = new mongoose.Types.ObjectId();
    const r = await api[m](`/api/invoices/${id}`, m === "put" ? { status: "paid" } : undefined).then(rec);
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("Invoice not found");
  });
});

describe("Customer *", () => {
  test("missing client -> 400", async () => expect(is4xx((await create({ client: undefined })).status)).toBe(true));
  test("client 'abc' -> 400", async () => expect(is4xx((await create({ client: "abc" })).status)).toBe(true));
  test("deleted (non-existent) client id -> 400", async () => {
    expect(is4xx((await create({ client: String(new mongoose.Types.ObjectId()) })).status)).toBe(true);
  });
  test("other company's client id -> 400 (no cross-tenant link)", async () => {
    const r = await create({ client: String(S.B.customers.guj._id) });
    expect(is4xx(r.status)).toBe(true);
  });
});

describe("Project", () => {
  test("project of another customer -> 400", async () => {
    expect(is4xx((await create({ project: String(S.A.projects.mah._id) })).status)).toBe(true);
  });
  test("other company's project id -> 400", async () => {
    expect(is4xx((await create({ project: String(S.B.projects.guj._id) })).status)).toBe(true);
  });
  test("project 'abc' -> 400", async () => expect(is4xx((await create({ project: "abc" })).status)).toBe(true));
});

describe("Invoice Number *", () => {
  test("empty -> auto number given", async () => {
    const r = await create({ number: "" });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^INV-\d+$/);
  });
  test("spaces only -> rejected", async () => expect(is4xx((await create({ number: "   " })).status)).toBe(true));
  test("duplicate in same company -> 400 'already used'", async () => {
    await create({ number: "DUP-1" });
    const r = await create({ number: "DUP-1" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/already used/);
  });
  test("other company's number (INV-SHARED-1 exists in every company) is reusable — numbers are per company", async () => {
    await Invoice.deleteOne({ tenant_id: S.A.tenantId, number: "INV-SHARED-1" });
    expect((await create({ number: "INV-SHARED-1" })).status).toBe(201);
  });
  test("500 chars -> rejected (no length limit)", async () => expect(is4xx((await create({ number: "N".repeat(500) })).status)).toBe(true));
  test("<script> is stored as plain text (escaped on output — see UI XSS test)", async () => {
    const r = await create({ number: "<script>alert(1)</script>" });
    expect(r.status).toBe(201);
  });
  test("emoji / INV-INV-1 are accepted", async () => {
    expect((await create({ number: "INV-😀" })).status).toBe(201);
    expect((await create({ number: "INV-INV-1" })).status).toBe(201);
  });
  test("PUT number to a duplicate -> 400", async () => {
    const a = await create({ number: "PDUP-1" });
    await create({ number: "PDUP-2" });
    const r = await api.put(`/api/invoices/${a.body._id}`, { number: "PDUP-2" });
    expect(r.status).toBe(400);
  });
});

describe("Invoice Date * / Due Date", () => {
  test("date '' -> defaults to today", async () => expect((await create({ date: "" })).status).toBe(201));
  test.each(["31-02-2026", "abc"])("date %s -> 400", async (d) => expect(is4xx((await create({ date: d })).status)).toBe(true));
  test.each(["1900-01-01", "9999-12-31"])("date %s -> rejected as out of range", async (d) => expect(is4xx((await create({ date: d })).status)).toBe(true));
  test("due date before invoice date -> 400", async () => {
    expect(is4xx((await create({ date: "2026-10-10", duedate: "2026-10-01" })).status)).toBe(true);
  });
  test("due date 'abc' -> 400", async () => expect(is4xx((await create({ duedate: "abc" })).status)).toBe(true));
  test("due date empty -> date + 30 days", async () => {
    const r = await create({ date: "2026-10-01", duedate: "" });
    expect(r.body.duedate.slice(0, 10)).toBe("2026-10-31");
  });
});

describe("Text fields (Voucher Type, Party Group, Terms of Payment, VAT, Party Address, notes)", () => {
  test.each(["voucherType", "partyGroup", "termsOfPayment"])("%s spaces only is trimmed to ''", async (f) => {
    const r = await create({ [f]: "    " });
    expect(r.body[f]).toBe("");
  });
  test.each(["voucherType", "partyGroup", "termsOfPayment", "vat"])("%s 500 chars -> rejected", async (f) => {
    expect(is4xx((await create({ [f]: "x".repeat(500) })).status)).toBe(true);
  });
  test("Party Address 5000 chars + newlines -> rejected (no length limit)", async () => {
    expect(is4xx((await create({ partyAddress: ("line\n").repeat(1000) })).status)).toBe(true);
  });
  test("Admin Note over 10000 chars -> rejected (no length limit)", async () => {
    expect(is4xx((await create({ adminnote: "a".repeat(10001) })).status)).toBe(true);
  });
});

describe("GSTIN/UIN", () => {
  test("lowercase -> saved uppercase", async () => {
    expect((await create({ gstin: "24aaaaa1111a1z5" })).body.gstin).toBe("24AAAAA1111A1Z5");
  });
  test.each(["ABC", "24AAAAA1111A1Z", "24AAAAA1111A1Z55"])("invalid GSTIN %s -> 400", async (g) => {
    expect(is4xx((await create({ gstin: g })).status)).toBe(true);
  });
  test("invoice GSTIN decides GST split (invoice gstin 27..., customer GSTIN 24...) -> IGST", async () => {
    const r = await create({ gstin: "27BBBBB2222B1Z5", items: [item({ tax: 18 })] });
    expect(r.body.tax_type).toBe("IGST");
  });
});

describe("Currency / Sale Agent / Bank Details / Branch / Sales Person", () => {
  test.each(["XYZ"])("currency %s (not in Setup > Currencies) -> 400", async (c) => {
    expect(is4xx((await create({ currency: c })).status)).toBe(true);
  });
  test("Sale Agent = other company's staff -> 400", async () => {
    expect(is4xx((await create({ created_by: String(S.B.admin.id) })).status)).toBe(true);
  });
  test("bank_detail 'abc' -> 400", async () => expect(is4xx((await create({ bank_detail: "abc" })).status)).toBe(true));
  test("bank_detail inactive -> 400", async () => {
    expect(is4xx((await create({ bank_detail: String(S.A.bank[1]._id) })).status)).toBe(true);
  });
  test("bank_detail of other company -> 400", async () => {
    expect(is4xx((await create({ bank_detail: String(S.B.bank[0]._id) })).status)).toBe(true);
  });
  test("branch name that is not an HRMS branch -> 400", async () => {
    expect(is4xx((await create({ branch: "Nowhere Branch" })).status)).toBe(true);
  });
  test("branch name of another company -> 400", async () => {
    expect(is4xx((await create({ branch: S.B.branches[0].name })).status)).toBe(true);
  });
});

describe("Discount / Adjustment", () => {
  test.each([[-10], [150], [1e9]])("discount_percent %p -> 400", async (d) => {
    expect(is4xx((await create({ discount_percent: d })).status)).toBe(true);
  });
  test("discount 10.555 -> discount 10.56 on 100 (to the paisa)", async () => {
    const r = await create({ discount_percent: 10.555 });
    expect(r.body.discount_total).toBe(10.56);
  });
  test("discount 'abc' -> 400", async () => expect(is4xx((await create({ discount_percent: "abc" })).status)).toBe(true));
  test("adjustment -1e9 -> negative total rejected", async () => {
    expect(is4xx((await create({ adjustment: -1e9 })).status)).toBe(true);
  });
  test("adjustment 0.005 -> total 100.01 (rounded)", async () => {
    expect((await create({ adjustment: 0.005 })).body.total).toBe(100.01);
  });
  test("adjustment 'abc' -> 400", async () => expect(is4xx((await create({ adjustment: "abc" })).status)).toBe(true));
});

describe("Status", () => {
  test("status 'foo' -> 400 (not 500)", async () => expect((await create({ status: "foo" })).status).toBe(400));
  test("status 'paid' with no payment -> rejected", async () => expect(is4xx((await create({ status: "paid" })).status)).toBe(true));
  test("status 'recorded' with no payment -> rejected", async () => expect(is4xx((await create({ status: "recorded" })).status)).toBe(true));
  test("PUT status 'paid' (Mark as Paid) with no payment -> rejected", async () => {
    const a = await create({});
    expect(is4xx((await api.put(`/api/invoices/${a.body._id}`, { status: "paid" })).status)).toBe(true);
  });
});

describe("Items", () => {
  test("items [] -> 400 'Enter at least one item'", async () => expect(is4xx((await create({ items: [] })).status)).toBe(true));
  test("items missing -> 400", async () => expect(is4xx((await create({ items: undefined })).status)).toBe(true));
  test("items 'abc' -> 400", async () => expect(is4xx((await create({ items: "abc" })).status)).toBe(true));
  test("1000 items -> 201 and total correct", async () => {
    const r = await create({ items: Array.from({ length: 1000 }, () => item({ rate: 1.11 })) });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(1110);
  });
  test("qty 0 -> line counts 0 (not 1)", async () => expect((await create({ items: [item({ qty: 0 })] })).body.total).toBe(0));
  test.each([[-5], ["abc"]])("qty %p -> 400", async (q) => expect(is4xx((await create({ items: [item({ qty: q })] })).status)).toBe(true));
  test("qty 1.5 x 100 -> 150", async () => expect((await create({ items: [item({ qty: 1.5 })] })).body.total).toBe(150));
  test("qty 1e10 x 100 -> stored exactly", async () => expect((await create({ items: [item({ qty: 1e10 })] })).body.total).toBe(1e12));
  test.each([[-100], ["abc"]])("rate %p -> 400", async (rt) => expect(is4xx((await create({ items: [item({ rate: rt })] })).status)).toBe(true));
  test("rate 0.001 -> total rounded 0.00", async () => expect((await create({ items: [item({ rate: 0.001 })] })).body.total).toBe(0));
  test("freight -1 -> 400", async () => expect(is4xx((await create({ items: [item({ freight_charge: -1 })] })).status)).toBe(true));
  test.each([[-18], [150], ["abc"]])("GST %% %p -> 400", async (g) => {
    expect(is4xx((await create({ items: [item({ tax: g, gstPercentage: g })] })).status)).toBe(true);
  });
  test("GST % 18 + Tax 5% -> 5% wins (same as UI)", async () => {
    expect((await create({ items: [item({ tax: 5, gstPercentage: 18 })] })).body.total).toBe(105);
  });
  test("Tax 'Zero' (0) + GST % 18 -> 0 tax (UI shows 0)", async () => {
    expect((await create({ items: [item({ tax: 0, gstPercentage: 18 })] })).body.total).toBe(100);
  });
});

describe("Mass assignment (create + update)", () => {
  test("create: tenant_id in body is ignored", async () => {
    const r = await create({ tenant_id: String(S.B.tenantId) });
    expect(String(r.body.tenant_id)).toBe(String(S.A.tenantId));
  });
  test("create: client-sent total / subtotal are ignored", async () => {
    const r = await create({ total: 1, subtotal: 1 });
    expect(r.body.total).toBe(100);
    expect(r.body.subtotal).toBe(100);
  });
  test("create: client-sent total_tax is ignored (server value used)", async () => {
    const r = await create({ items: [item({ tax: 18 })], total_tax: 99999 });
    expect(r.body.total_tax).toBe(18);
  });
  test("create: client-sent _id is ignored", async () => {
    const id = new mongoose.Types.ObjectId();
    const r = await create({ _id: String(id) });
    expect(r.body._id).not.toBe(String(id));
  });
  test("create: client-sent createdAt is ignored", async () => {
    const r = await create({ createdAt: "2000-01-01T00:00:00.000Z" });
    expect(r.body.createdAt.slice(0, 4)).not.toBe("2000");
  });
  test("update: tenant_id in body is ignored", async () => {
    const a = await create({});
    await api.put(`/api/invoices/${a.body._id}`, { tenant_id: String(S.B.tenantId) });
    expect(String((await Invoice.findById(a.body._id)).tenant_id)).toBe(String(S.A.tenantId));
  });
  test("update: client-sent total_tax is ignored", async () => {
    const a = await create({});
    const u = await api.put(`/api/invoices/${a.body._id}`, { total_tax: 5000 });
    expect(u.body.total_tax).not.toBe(5000);
  });
  test("update: total alone cannot be overwritten", async () => {
    const a = await create({});
    const u = await api.put(`/api/invoices/${a.body._id}`, { total: 1 });
    expect(u.body.total).toBe(100);
  });
});

describe("Delete rules", () => {
  test("delete invoice with a payment -> 400 with message", async () => {
    const a = await create({});
    await Payment.create({ invoice: a.body._id, amount: 1, tenant_id: S.A.tenantId });
    const r = await api.del(`/api/invoices/${a.body._id}`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Cannot delete an invoice with recorded payments. Remove the payments first.");
  });
  test("bulk delete with empty ids -> 400 'No invoice ids provided'", async () => {
    const r = await api.post("/api/invoices/bulk-delete", { ids: [] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("No invoice ids provided");
  });
  test("bulk delete with 'abc' id -> 400 (not 500)", async () => {
    expect(is4xx((await api.post("/api/invoices/bulk-delete", { ids: ["abc"] }).then(rec)).status)).toBe(true);
  });
});

describe("Payments (Record Payment)", () => {
  test.each([[0], [-5]])("amount %p -> 400", async (a) => {
    const inv = await create({});
    expect(is4xx((await api.post("/api/payments", { invoice: inv.body._id, amount: a, paymentmode: "Bank" }).then(rec)).status)).toBe(true);
  });
  test("overpay (more than balance due) -> rejected or warned", async () => {
    const inv = await create({});
    expect(is4xx((await api.post("/api/payments", { invoice: inv.body._id, amount: 1000, paymentmode: "Bank" }).then(rec)).status)).toBe(true);
  });
  test("payment mode empty -> 400", async () => {
    const inv = await create({});
    expect(is4xx((await api.post("/api/payments", { invoice: inv.body._id, amount: 1, paymentmode: "" }).then(rec)).status)).toBe(true);
  });
  test("payment date before invoice date -> 400", async () => {
    const inv = await create({ date: "2026-10-10" });
    expect(is4xx((await api.post("/api/payments", { invoice: inv.body._id, amount: 1, paymentmode: "Bank", date: "2026-01-01" }).then(rec)).status)).toBe(true);
  });
  test("deleting the last payment of a cancelled invoice keeps it cancelled", async () => {
    const inv = await create({ status: "cancelled" });
    const p = await api.post("/api/payments", { invoice: inv.body._id, amount: 1, paymentmode: "Bank" });
    await api.del(`/api/payments/${p.body._id}`);
    expect((await Invoice.findById(inv.body._id)).status).toBe("cancelled");
  });
});

describe("Import", () => {
  test("empty array -> 400", async () => expect((await api.post("/api/invoices/import", []).then(rec)).status).toBe(400));
  test("no Party Name column -> 400 with message", async () => {
    const r = await api.post("/api/invoices/import", [{ "Voucher Number": "X1", Rate: 1 }]).then(rec);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/No importable rows/);
  });
  test("qty 0 in the sheet -> line qty 0 (not 1)", async () => {
    await api.post("/api/invoices/import", [{ "Voucher Number": "QZ-1", "Party Name": S.A.customers.guj.company, Quantity: 0, Rate: 100 }]);
    const inv = await Invoice.findOne({ tenant_id: S.A.tenantId, number: "QZ-1" }).lean();
    expect(inv.total).toBe(0);
  });
  test("party name with regex chars 'A+B (India)' matches the existing customer (no duplicate)", async () => {
    await Client.create({ company: "A+B (India)", tenant_id: S.A.tenantId });
    await api.post("/api/invoices/import", [{ "Voucher Number": "RX-1", "Party Name": "A+B (India)", Rate: 1 }]);
    expect(await Client.countDocuments({ tenant_id: S.A.tenantId, company: /^a\+b \(india\)$/i })).toBe(1);
  });
  test("party name 'Bad (Name' does not crash the import (500)", async () => {
    const r = await api.post("/api/invoices/import", [{ "Voucher Number": "RX-2", "Party Name": "Bad (Name", Rate: 1 }]).then(rec);
    expect(r.status).toBe(201);
  });
  test("party name '.*' does not attach the invoice to some other existing customer", async () => {
    await api.post("/api/invoices/import", [{ "Voucher Number": "RX-3", "Party Name": ".*", Rate: 1 }]);
    const inv = await Invoice.findOne({ tenant_id: S.A.tenantId, number: "RX-3" }).populate("client").lean();
    expect(inv.client.company).toBe(".*");
  });
  test("negative amounts in sheet (Rate -100) -> row rejected", async () => {
    const r = await api.post("/api/invoices/import", [{ "Voucher Number": "NEGR-1", "Party Name": S.A.customers.guj.company, Rate: -100 }]).then(rec);
    const inv = await Invoice.findOne({ tenant_id: S.A.tenantId, number: "NEGR-1" }).lean();
    expect(inv).toBeNull();
    expect(r.status).toBeLessThan(500);
  });
});
