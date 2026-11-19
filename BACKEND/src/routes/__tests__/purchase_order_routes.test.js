const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Staff = require("../../models/Staff");
const Tenant = require("../../models/Tenant");
const Role = require("../../models/Role");
const PoItem = require("../../models/PoItem");

// End-to-end through the real router: auth -> add-on gate -> permission
// gate -> controller, including the multipart PDF upload for WhatsApp.
describe("/api/purchase-orders routes", () => {
  let mongoServer, server, base, trinetraAdmin, viewer, otherAdmin, noPermStaff, item, customer;

  const token = (staff) => jwt.sign({ id: staff._id, role: "staff" }, process.env.JWT_SECRET);
  const api = (staff, path, opts = {}) =>
    fetch(`${base}/api/purchase-orders${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token(staff)}`, ...(opts.json ? { "Content-Type": "application/json" } : {}) },
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = "po-routes-test-secret";
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    if (!uri.includes("127.0.0.1") && !uri.includes("localhost")) throw new Error("Not an in-memory DB");
    await mongoose.connect(uri);

    const trinetra = await Tenant.create({ company_name: "Trinetra", status: "active", enabled_features: ["purchase_orders"] });
    const other = await Tenant.create({ company_name: "Other", status: "active" });
    // Purchase Orders is limited to the tenant ids in this env var (config/tenantFeatures).
    process.env.PURCHASE_ORDERS_TENANT_IDS = String(trinetra._id);
    const viewRole = await Role.create({ name: "PO Viewer", permissions: { "Purchase Orders": { "View(Global)": true } } });
    trinetraAdmin = await Staff.create({ firstname: "A", lastname: "T", email: "a@t.test", password: "x", admin: true, tenant_id: trinetra._id });
    viewer = await Staff.create({ firstname: "V", lastname: "T", email: "v@t.test", password: "x", tenant_id: trinetra._id, role: viewRole._id });
    noPermStaff = await Staff.create({ firstname: "N", lastname: "T", email: "n@t.test", password: "x", tenant_id: trinetra._id });
    otherAdmin = await Staff.create({ firstname: "O", lastname: "O", email: "o@o.test", password: "x", admin: true, tenant_id: other._id });
    item = await PoItem.create({ name: "Label", tenant_id: trinetra._id, cost_price: 70, end_customer_price: 100 });
    // Round 29 (S4): a PO needs a customer.
    customer = await require("../../models/Client").create({ company: "Route Test Customer", tenant_id: trinetra._id });

    const app = express();
    app.use(express.json());
    app.use("/api/purchase-orders", require("../purchase_order_routes"));
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test("another company gets 403 on every route", async () => {
    for (const path of ["", "/settings", "/items", "/stats"]) {
      const res = await api(otherAdmin, path);
      expect(res.status).toBe(403);
    }
  });

  test("Trinetra staff without the permission get 403; no token gets 401", async () => {
    expect((await api(noPermStaff, "")).status).toBe(403);
    expect((await fetch(`${base}/api/purchase-orders`)).status).toBe(401);
  });

  test("a viewer can list but not create", async () => {
    expect((await api(viewer, "")).status).toBe(200);
    const res = await api(viewer, "", { method: "POST", json: { type: "purchase", division: "brady", items: [{ item_id: item._id, qty: 1 }] } });
    expect(res.status).toBe(403);
  });

  test("create, submit, fetch with its format, then WhatsApp upload reaches the handler", async () => {
    const created = await api(trinetraAdmin, "", {
      method: "POST",
      json: { type: "purchase", division: "brady", customer: String(customer._id), items: [{ item_id: item._id, qty: 3 }], submit: true },
    });
    expect(created.status).toBe(201);
    const created1 = await created.json();
    // R4: every PO waits for an approver's Yes, also an admin's own PO.
    expect(created1.status).toBe("pending_approval");
    const approved = await api(trinetraAdmin, `/${created1._id}/approve`, { method: "POST", json: {} });
    const po = await approved.json();
    expect(po.status).toBe("approved");

    const fetched = await (await api(trinetraAdmin, `/${po._id}`)).json();
    expect(fetched.format.title_purchase).toBe("Purchase Order");
    expect(fetched.history[0].by.firstname).toBe("A");

    // No WhatsApp number connected in this test DB: the upload is parsed and
    // the handler answers with a clear 400, not a crash.
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }), `${po.po_number}.pdf`);
    const sent = await api(trinetraAdmin, `/${po._id}/whatsapp`, { method: "POST", body: form });
    expect(sent.status).toBe(400);
    expect((await sent.json()).message).toMatch(/Connect a WhatsApp number/);
  });
});
