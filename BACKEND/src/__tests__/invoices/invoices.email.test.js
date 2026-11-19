// Invoices — "Send Invoice to Email" (Save & Send): draft, send with PDF, permissions, tenants.
// nodemailer is mocked, so no real email leaves the machine.
const sent = [];
jest.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: "test" }; } }),
}));

const mongoose = require("mongoose");
const { startInvoiceApi, stop } = require("../../testUtils/invoiceHarness");
const { TENANTS } = require("../../testUtils/invoiceSeed");

jest.setTimeout(120000);

// Smallest valid PDF header + body, base64.
const PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");

let H, Invoice, Contact;
beforeAll(async () => {
  H = await startInvoiceApi();
  Invoice = require("../../models/Invoice");
  Contact = require("../../models/Contact");
  // SMTP for every tenant except OffixNest (to test the "not configured" message).
  const settings = mongoose.connection.db.collection("settings");
  for (const t of TENANTS.filter((x) => x.key !== "offixnest")) {
    const tid = H.seed[t.key].tenantId;
    await settings.insertMany([
      { name: "smtpHost", value: "smtp.test.local", tenant_id: tid },
      { name: "smtpEmail", value: `billing@${t.key}.test`, tenant_id: tid },
    ]);
  }
});
afterAll(stop);

const newInvoice = async (T, extra = {}) => {
  const r = await H.as(T.admin).post("/api/invoices", { client: String(T.customers.guj._id), items: [{ description: "Widget", qty: 1, rate: 100 }], ...extra });
  expect(r.status).toBe(201);
  return r.body;
};

describe.each(TENANTS.map((t) => [t.label, t.key]))("[%s]", (_label, tkey) => {
  let T, api, inv;
  beforeAll(async () => {
    T = H.seed[tkey];
    api = H.as(T.admin);
    await Contact.create([
      { userid: T.customers.guj._id, firstname: "Asha", lastname: "Shah", email: `asha@${tkey}.cust`, is_primary: true, active: true, invoice_emails: true },
      { userid: T.customers.guj._id, firstname: "No", lastname: "Mail", email: `nomail@${tkey}.cust`, active: true, invoice_emails: false },
    ]);
    inv = await newInvoice(T);
  });

  test("email-draft: To = contacts with 'Invoice emails' ticked; template filled in", async () => {
    const r = await api.get(`/api/invoices/${inv._id}/email-draft`);
    expect(r.status).toBe(200);
    expect(r.body.to).toEqual([`asha@${tkey}.cust`]);
    expect(r.body.subject).toContain(inv.number);
    expect(r.body.message).toContain("Asha Shah");
    expect(r.body.message).toContain("100.00");
    expect(r.body.message).not.toMatch(/\{invoice_number\}|\{contact_name\}/);
  });

  test("send with PDF → 200, mail has the PDF, status becomes 'sent', email_log saved", async () => {
    if (tkey === "offixnest") return;
    sent.length = 0;
    const r = await api.post(`/api/invoices/${inv._id}/send-email`, { to: `asha@${tkey}.cust`, cc: "boss@x.com", subject: "Inv", message: "Hello", pdf_base64: PDF_B64 });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([`asha@${tkey}.cust`]);
    expect(sent[0].cc).toEqual(["boss@x.com"]);
    expect(sent[0].attachments[0].filename).toBe(`Invoice_${inv.number.replace(/[^\w.-]+/g, "_")}.pdf`);
    expect(sent[0].attachments[0].content.subarray(0, 5).toString()).toBe("%PDF-");
    const db = await Invoice.findById(inv._id).lean();
    expect(db.status).toBe("sent");
    expect(db.email_log).toHaveLength(1);
    expect(db.email_log[0]).toMatchObject({ to: [`asha@${tkey}.cust`], pdf_attached: true });
  });

  test("tenant without SMTP → 400 'SMTP not configured', status unchanged", async () => {
    if (tkey !== "offixnest") return;
    const r = await api.post(`/api/invoices/${inv._id}/send-email`, { to: "a@b.com", subject: "s", message: "m" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/SMTP not configured/);
    expect((await Invoice.findById(inv._id).lean()).status).toBe("unpaid");
  });

  test("validation: no To / bad email / not a PDF / empty subject → 400, nothing sent", async () => {
    sent.length = 0;
    const url = `/api/invoices/${inv._id}/send-email`;
    expect((await api.post(url, { to: "", subject: "s", message: "m" })).status).toBe(400);
    expect((await api.post(url, { to: "not-an-email", subject: "s", message: "m" })).status).toBe(400);
    expect((await api.post(url, { to: "a@b.com", subject: "s", message: "m", pdf_base64: Buffer.from("<html>").toString("base64") })).status).toBe(400);
    expect((await api.post(url, { to: "a@b.com", subject: "", message: "m" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("view-only staff cannot send (403), but can load the draft", async () => {
    expect((await H.as(T.viewer).post(`/api/invoices/${inv._id}/send-email`, { to: "a@b.com", subject: "s", message: "m" })).status).toBe(403);
    expect((await H.as(T.viewer).get(`/api/invoices/${inv._id}/email-draft`)).status).toBe(200);
  });

  test("another tenant's invoice → 404 for draft and send", async () => {
    const other = H.seed[TENANTS[(TENANTS.findIndex((t) => t.key === tkey) + 1) % TENANTS.length].key];
    const theirs = await newInvoice(other);
    expect((await api.get(`/api/invoices/${theirs._id}/email-draft`)).status).toBe(404);
    expect((await api.post(`/api/invoices/${theirs._id}/send-email`, { to: "a@b.com", subject: "s", message: "m" })).status).toBe(404);
  });
});

test("a paid invoice stays 'paid' after it is emailed", async () => {
  const T = H.seed.beontime;
  const inv = await newInvoice(T);
  await H.as(T.admin).post("/api/payments", { invoice: inv._id, amount: 100, paymentmode: "Bank", date: new Date().toISOString().slice(0, 10) });
  const r = await H.as(T.admin).post(`/api/invoices/${inv._id}/send-email`, { to: "a@b.com", subject: "s", message: "m" });
  expect(r.status).toBe(200);
  expect((await Invoice.findById(inv._id).lean()).status).toBe("paid");
});
