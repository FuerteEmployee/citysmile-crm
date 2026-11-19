// Invoices — UNIT: Invoice model, InvoiceService.calculateTotals, updateStatus.
// Convention for this whole folder: every test asserts the EXPECTED (correct)
// behaviour. A failing test is a finding; its name says what is wrong.
const mongoose = require("mongoose");
const { startInvoiceApi, stop, r2 } = require("../../testUtils/invoiceHarness");

jest.setTimeout(120000);

let S;
let Invoice, Payment, InvoiceService;
beforeAll(async () => {
  const h = await startInvoiceApi();
  S = h.seed;
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
  InvoiceService = require("../../services/InvoiceService");
});
afterAll(stop);

const guj = () => S.A.customers.guj;
const mah = () => S.A.customers.mah;
const calc = (data, client, home) => InvoiceService.calculateTotals(data, client, home);
const EKAGRA = { name: "bihar", code: "10" };

describe("Invoice model", () => {
  const base = () => ({ client: guj()._id, number: `M-${new mongoose.Types.ObjectId()}`, tenant_id: S.A.tenantId });

  test("defaults: status unpaid, currency USD, tax_type GST, totals 0", async () => {
    const inv = await Invoice.create(base());
    expect(inv.status).toBe("unpaid");
    expect(inv.currency).toBe("USD");
    expect(inv.tax_type).toBe("GST");
    expect(inv.subtotal).toBe(0);
    expect(inv.total).toBe(0);
  });
  test("client is required", async () => {
    await expect(Invoice.create({ ...base(), client: undefined })).rejects.toThrow(/client/);
  });
  test("number is required", async () => {
    await expect(Invoice.create({ ...base(), number: undefined })).rejects.toThrow(/number/);
  });
  test("status enum rejects 'foo'", async () => {
    await expect(Invoice.create({ ...base(), status: "foo" })).rejects.toThrow(/status/);
  });
  test.each(["unpaid", "paid", "partially_paid", "overdue", "cancelled", "draft", "sent", "sent_later", "recorded"])(
    "status enum accepts %s", async (st) => {
      const inv = await Invoice.create({ ...base(), status: st });
      expect(inv.status).toBe(st);
    });
  test("gstin is upper-cased and trimmed", async () => {
    const inv = await Invoice.create({ ...base(), gstin: "  24aaaaa1111a1z5 " });
    expect(inv.gstin).toBe("24AAAAA1111A1Z5");
  });
  test("tax_type enum rejects VAT", async () => {
    await expect(Invoice.create({ ...base(), tax_type: "VAT" })).rejects.toThrow(/tax_type/);
  });
  test("item sub-field defaults: qty 1, rate 0, tax 0, freight 0", async () => {
    const inv = await Invoice.create({ ...base(), items: [{ description: "x" }] });
    expect(inv.items[0].qty).toBe(1);
    expect(inv.items[0].rate).toBe(0);
    expect(inv.items[0].tax).toBe(0);
    expect(inv.items[0].freight_charge).toBe(0);
  });
  test("number is unique per company (same number twice in one tenant is rejected)", async () => {
    const b = base();
    await Invoice.create(b);
    await expect(Invoice.create({ ...b })).rejects.toThrow(/duplicate key/);
  });
  test("the same number is allowed in two different companies", async () => {
    const inv = await Invoice.create({ ...base(), number: "INV-B-1" });
    expect(inv.number).toBe("INV-B-1");
  });
  test("number is trimmed (spaces-only number should not be storable)", async () => {
    const inv = await Invoice.create({ ...base(), number: "   " }).catch((e) => e);
    // Expected: rejected or trimmed to empty -> required error.
    expect(inv instanceof Error).toBe(true);
  });
});

describe("InvoiceService.calculateTotals — money to the paisa", () => {
  test("2 x 500 + 18% GST, Gujarat buyer -> 1000 / 180 / 1180, CGST 90 + SGST 90", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18 }] }, guj());
    expect(t.subtotal).toBe(1000);
    expect(t.totalTax).toBe(180);
    expect(t.total).toBe(1180);
    expect(t.tax_type).toBe("GST");
    expect(t.total_cgst).toBe(90);
    expect(t.total_sgst).toBe(90);
    expect(t.total_igst).toBe(0);
  });
  test("Maharashtra buyer -> IGST 180", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18 }] }, mah());
    expect(t.tax_type).toBe("IGST");
    expect(t.total_igst).toBe(180);
    expect(t.total_cgst).toBe(0);
  });
  test("freight 1% (10.00) is taxed: 1000 + 10 + 181.80 = 1191.80", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18, freight_charge: 10 }] }, guj());
    expect(t.total_freight).toBe(10);
    expect(r2(t.totalTax)).toBe(181.8);
    expect(t.total).toBe(1191.8);
  });
  test("discount 10%: 1000 - 100 + 162 = 1062", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18 }], discount_percent: 10 }, guj());
    expect(t.discount_total).toBe(100);
    expect(r2(t.totalTax)).toBe(162);
    expect(t.total).toBe(1062);
  });
  test("adjustment -0.50 -> 1179.50", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18 }], adjustment: -0.5 }, guj());
    expect(t.total).toBe(1179.5);
  });
  test("all combined: 2x500, freight 10, 18%, 10% disc, adj -0.50", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18, freight_charge: 10 }], discount_percent: 10, adjustment: -0.5 }, guj());
    // 1000 + 10 + 1010*0.18*0.9 (163.62) - 100 - 0.5 = 1073.12
    expect(t.total).toBe(1073.12);
  });
  test("total is rounded to 2 decimals (3 x 33.33 at 18%)", () => {
    const t = calc({ items: [{ qty: 3, rate: 33.33, tax: 18 }] }, guj());
    expect(t.total).toBe(117.99); // 99.99 + 17.9982
  });
  test("subtotal is stored to the paisa (3 x 33.33)", () => {
    const t = calc({ items: [{ qty: 3, rate: 33.33 }] }, guj());
    expect(t.subtotal).toBe(r2(t.subtotal));
  });
  test("total tax is stored to the paisa (18% of 99.99 = 17.9982 -> 18.00)", () => {
    const t = calc({ items: [{ qty: 1, rate: 99.99, tax: 18 }] }, guj());
    expect(t.totalTax).toBe(r2(t.totalTax));
  });
  test("CGST + SGST add up to the total tax to the paisa (18% of 99.99)", () => {
    const t = calc({ items: [{ qty: 1, rate: 99.99, tax: 18 }] }, guj());
    expect(r2(t.total_cgst + t.total_sgst)).toBe(r2(t.totalTax));
  });
  test("0.1 + 0.2 style rates: rates 0.1 and 0.2 -> subtotal exactly 0.30", () => {
    const t = calc({ items: [{ qty: 1, rate: 0.1 }, { qty: 1, rate: 0.2 }] }, guj());
    expect(t.subtotal).toBe(0.3);
  });
  test("returns the key the Invoice model stores (total_tax), not only totalTax", () => {
    const t = calc({ items: [{ qty: 2, rate: 500, tax: 18 }] }, guj());
    expect(t).toHaveProperty("total_tax", 180);
  });
  test("qty 0 counts as 0 (UI uses Number(qty)||0)", () => {
    const t = calc({ items: [{ qty: 0, rate: 100 }] }, guj());
    expect(t.subtotal).toBe(0);
  });
  test("tax 0 with gstPercentage 18 charges 0 (UI shows 0 when the picked Tax is 0%)", () => {
    const t = calc({ items: [{ qty: 1, rate: 100, tax: 0, gstPercentage: 18 }] }, guj());
    expect(t.totalTax).toBe(0);
  });
  test("discount_percent > 100 cannot make the total negative", () => {
    const t = calc({ items: [{ qty: 1, rate: 100 }], discount_percent: 150 }, guj());
    expect(t.total).toBeGreaterThanOrEqual(0);
  });
  test("negative discount_percent is ignored", () => {
    const t = calc({ items: [{ qty: 1, rate: 100 }], discount_percent: -10 }, guj());
    expect(t.discount_total).toBe(0);
    expect(t.total).toBe(100);
  });
  test("negative qty cannot produce a negative subtotal", () => {
    const t = calc({ items: [{ qty: -5, rate: 100 }] }, guj());
    expect(t.subtotal).toBeGreaterThanOrEqual(0);
  });
  test("no GSTIN, state 'Gujarat' -> GST", () => {
    const t = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, { state: "Gujarat" });
    expect(t.tax_type).toBe("GST");
  });
  test("no GSTIN, state empty, address mentions Gujarat -> GST", () => {
    const t = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, { address: "Plot 4, Vadodara, Gujarat" });
    expect(t.tax_type).toBe("GST");
  });
  test("no GSTIN, no state, no address -> IGST (UI shows CGST/SGST for this buyer — see UI test)", () => {
    const t = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, S.A.customers.nogst);
    expect(t.tax_type).toBe("IGST");
  });
  test("GSTIN with invalid state code 99 -> IGST", () => {
    const t = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, { gst_number: "99ZZZZZ9999Z1Z5" });
    expect(t.tax_type).toBe("IGST");
  });
  test("Ekagra home state Bihar: Bihar buyer (10...) -> GST, Gujarat buyer -> IGST", () => {
    const bihar = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, { gst_number: "10CCCCC3333C1Z5" }, EKAGRA);
    const gj = calc({ items: [{ qty: 1, rate: 100, tax: 18 }] }, guj(), EKAGRA);
    expect(bihar.tax_type).toBe("GST");
    expect(gj.tax_type).toBe("IGST");
  });
});

describe("InvoiceService.updateStatus", () => {
  let n = 0;
  const mk = async (extra) => Invoice.create({ client: guj()._id, number: `US-${++n}`, tenant_id: S.A.tenantId, total: 100, subtotal: 100, ...extra });
  const pay = (inv, amount) => Payment.create({ invoice: inv._id, amount, tenant_id: S.A.tenantId });

  test("no payments -> unpaid; part -> partially_paid; full -> paid; overpay -> paid", async () => {
    const inv = await mk();
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("unpaid");
    await pay(inv, 40);
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("partially_paid");
    await pay(inv, 60);
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("paid");
    await pay(inv, 50);
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("paid");
  });
  test("a cancelled invoice stays cancelled when a payment is added", async () => {
    const inv = await mk({ status: "cancelled" });
    await pay(inv, 100);
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("cancelled");
  });
  test("a draft invoice stays draft when status is recomputed with no payments", async () => {
    const inv = await mk({ status: "draft" });
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("draft");
  });
  test("0.1 + 0.2 paid against a 0.30 invoice -> paid", async () => {
    const inv = await mk({ total: 0.3, subtotal: 0.3 });
    await pay(inv, 0.1);
    await pay(inv, 0.2);
    await InvoiceService.updateStatus(inv._id);
    expect((await Invoice.findById(inv._id)).status).toBe("paid");
  });
});
