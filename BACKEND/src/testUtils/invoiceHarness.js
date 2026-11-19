// Starts the in-memory API used by src/__tests__/invoices/*.test.js and seeds it.
const app = require("./crmTestApp");
const { seedAll } = require("./invoiceSeed");

const ROUTES = [
  ["/api/invoices", "routes/invoice_routes"],
  ["/api/payments", "routes/payment_routes"],
  ["/api/credit-notes", "routes/credit_note_routes"],
  ["/api/estimates", "routes/estimate_routes"],
  ["/api/clients", "routes/client_routes"],
  ["/api/bank-details", "routes/bank_detail_routes"],
  ["/api/mainsidebar", "routes/mainsidebar_routes"],
];

async function startInvoiceApi() {
  const { uri, baseUrl } = await app.start(ROUTES);
  const seed = await seedAll();
  return { uri, baseUrl, seed, as: (who) => app.client(who && who.token), anon: app.client(null) };
}

// Money rounded to the paisa, the precision every invoice figure should have.
const r2 = (n) => Math.round(Number(n) * 100) / 100;

module.exports = { startInvoiceApi, stop: app.stop, r2, client: app.client };
