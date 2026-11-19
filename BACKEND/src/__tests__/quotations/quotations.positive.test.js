// Quotation Maker — PHASE 1 positive tests (API + DB). A failing test is a bug.
jest.setTimeout(120000);

const { start, stop, seedAll, setFeatures, client, guard } = require("./quotationStack.cjs");

let A, Quotation;
const as = (u) => client(u.token);
const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const norm = (v) => (v instanceof Date ? v.toISOString() : v && v._bsontype ? String(v) : v);

beforeAll(async () => {
  await start();
  ({ A } = await seedAll());
  Quotation = require("../../models/Quotation");
});
afterAll(stop);

// Returns every field path whose value differs between the payload and the API response / DB doc.
const diffFields = (payload, resBody, dbDoc, paths) => {
  const bad = [];
  for (const p of paths) {
    let want = get(payload, p);
    if (p === "date" || p === "valid_till") want = new Date(want).toISOString();
    const api = norm(get(resBody, p));
    const db = norm(get(dbDoc, p));
    if (JSON.stringify(api) !== JSON.stringify(want)) bad.push(`API ${p}: ${JSON.stringify(api)} != ${JSON.stringify(want)}`);
    if (JSON.stringify(db) !== JSON.stringify(want)) bad.push(`DB  ${p}: ${JSON.stringify(db)} != ${JSON.stringify(want)}`);
  }
  return bad;
};

const BRANDING = {
  brandLogoUrl: "/uploads/logos/brand.png", clientLogoUrl: "/uploads/logos/client.png", brandName: "Trinetra",
  fullCompanyName: "Trinetra Technoworld Pvt Ltd", tagline: "Smart homes", contactAddress: "Surat, GJ", defaultContactNumber: "9800012345",
};
const THEME = { primaryColor: "#3592ea", roomHeaderBg: "#882200", headerText: "#ffffff", topBorder: "#3592ea", flatTypeBg: "#1f2937", flatTypeText: "#ffffff" };

const simplePayload = () => ({
  client: String(A.customers[0]._id), contact_number: "9876500001", client_address: "12 Ring Road, Surat",
  date: "2026-10-15", valid_till: "2026-11-04", status: "draft", quotation_type: String(A.types.trinetra._id),
  format: "simple", gst_percent: 12, notes: "Thanks for your business", adminnote: "internal", currency: "INR",
  show_item_images: false, bank_detail: String(A.bank._id), branding: BRANDING, theme: THEME,
  items: [
    { description: "LED Panel", long_description: "18W", qty: 2, rate: 150.5, tax: 12, tax_name: "GST", photo_url: "/uploads/media/led.png" },
    { description: "Wire", qty: 10, rate: 20 },
  ],
  subtotal: 501, discount_percent: 10, discount_total: 50.1, total_tax: 54.108, total: 505.008,
});

const proPayload = () => ({
  client: String(A.customers[1]._id), contact_number: "9876500002", client_address: "B-402 Skyline",
  date: "2026-10-20", valid_till: "2026-11-09", status: "sent", quotation_type: String(A.types.trinetra._id),
  format: "pro", gst_percent: 18, notes: "Pro notes", show_item_images: true, bank_detail: String(A.bank._id),
  branding: BRANDING, theme: { ...THEME, primaryColor: "#112233" },
  project_details: { project_building: "Skyline Towers", unit_no: "B-402", flat_type: "3BHK" },
  rooms: [
    { name: "Living Room", items: [
      { description: "Touch Panel", series: "Glass", model_no: "TP-4", unit_price: 4500, sw: 4, fan: 1, soc: 2, mod: 8, qty: 2, disc_percent: 5, photo_url: "/uploads/media/tp.png" },
    ] },
    { name: "Bedroom", items: [{ description: "Dimmer", series: "Classic", model_no: "DM-1", unit_price: 1200, sw: 1, fan: 0, soc: 0, mod: 2, qty: 3, disc_percent: 0 }] },
  ],
  attachments: { before_images: ["/uploads/media/before1.jpg"], after_images: ["/uploads/media/after1.jpg", "/uploads/media/after2.jpg"] },
  subtotal: 12150, discount_percent: 0, discount_total: 0, total_tax: 2187, total: 14337,
});

const SIMPLE_PATHS = [
  "client", "contact_number", "client_address", "date", "valid_till", "status", "quotation_type", "format", "gst_percent",
  "notes", "adminnote", "currency", "show_item_images", "bank_detail",
  ...Object.keys(BRANDING).map((k) => `branding.${k}`), ...Object.keys(THEME).map((k) => `theme.${k}`),
  ...["description", "long_description", "qty", "rate", "tax", "tax_name", "photo_url"].map((k) => `items.0.${k}`),
  "items.1.description", "items.1.qty", "items.1.rate",
  "subtotal", "discount_percent", "discount_total", "total_tax", "total",
];
const PRO_PATHS = [
  "client", "contact_number", "client_address", "date", "valid_till", "status", "format", "gst_percent", "notes", "show_item_images",
  "bank_detail", "theme.primaryColor", "branding.brandName", "branding.clientLogoUrl",
  "project_details.project_building", "project_details.unit_no", "project_details.flat_type",
  "rooms.0.name", ...["description", "series", "model_no", "unit_price", "sw", "fan", "soc", "mod", "qty", "disc_percent", "photo_url"].map((k) => `rooms.0.items.0.${k}`),
  "rooms.1.name", "rooms.1.items.0.model_no", "rooms.1.items.0.qty",
  "attachments.before_images", "attachments.after_images",
  "subtotal", "discount_percent", "discount_total", "total_tax", "total",
];

describe("create — every field round-trips to API response and DB", () => {
  test.each([["simple", simplePayload, SIMPLE_PATHS], ["pro", proPayload, PRO_PATHS]])("%s format", async (_l, mk, paths) => {
    const payload = mk();
    const r = await as(A.users.admin).post("/api/quotations", payload);
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^QUO-\d{6}$/);
    const db = await Quotation.findById(r.body._id).lean();
    expect(diffFields(payload, r.body, db, paths)).toEqual([]);
  });

  test("GET /:id returns populated client, type and bank detail (with branch)", async () => {
    const r0 = await as(A.users.admin).post("/api/quotations", simplePayload());
    const r = await as(A.users.admin).get(`/api/quotations/${r0.body._id}`);
    expect(r.status).toBe(200);
    expect([r.body.client.company, r.body.client.phonenumber, r.body.quotation_type.slug, r.body.bank_detail.bankName, r.body.bank_detail.branch?.name])
      .toEqual(["Cust A1", "9800000001", "trinetra-technoworld-pvt-ltd", "Test Bank", "Branch A1"]);
  });
});

describe("save / edit / list / paginate / stats / delete (add-on OFF)", () => {
  beforeAll(() => setFeatures(A.tenantId, []));

  test.each([
    ["draft without customer", { status: "draft" }, "draft"],
    ["sent with customer", () => ({ status: "sent", client: String(A.customers[0]._id) }), "sent"],
  ])("save %s", async (_l, body, want) => {
    const r = await as(A.users.maker).post("/api/quotations", typeof body === "function" ? body() : body);
    expect([r.status, r.body.status]).toEqual([201, want]);
    expect((await Quotation.findById(r.body._id).lean()).status).toBe(want);
  });

  test("edit keeps contact/address and saves changed fields (API + DB)", async () => {
    const q = (await as(A.users.admin).post("/api/quotations", simplePayload())).body;
    const upd = { contact_number: "9000000009", client_address: "New Addr 9", notes: "edited", total: 999, rooms: [], status: "sent" };
    const r = await as(A.users.admin).put(`/api/quotations/${q._id}`, upd);
    expect(r.status).toBe(200);
    const db = await Quotation.findById(q._id).lean();
    const pick = (o) => ({ c: o.contact_number, a: o.client_address, n: o.notes, t: o.total, s: o.status, num: o.number, br: o.branding?.brandName });
    const want = { c: "9000000009", a: "New Addr 9", n: "edited", t: 999, s: "sent", num: q.number, br: "Trinetra" };
    expect(pick(r.body)).toEqual(want);
    expect(pick(db)).toEqual(want);
  });

  test("list by ?quotation_type returns only that type", async () => {
    await as(A.users.admin).post("/api/quotations", { status: "draft", quotation_type: String(A.types.electrical._id) });
    const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${A.types.electrical._id}`);
    const dbCount = await Quotation.countDocuments({ tenant_id: A.tenantId, quotation_type: A.types.electrical._id });
    expect(r.body.length).toBe(dbCount);
    expect(r.body.every((q) => q.quotation_type.slug === "electrical")).toBe(true);
  });

  describe("pagination", () => {
    let typeId;
    beforeAll(async () => {
      const QuotationType = require("../../models/QuotationType");
      typeId = (await QuotationType.create({ name: "Page T", slug: "page-t", tenant_id: A.tenantId }))._id;
      await Quotation.insertMany(Array.from({ length: 120 }, (_, i) => ({
        number: `QUO-P${String(i).padStart(5, "0")}`, tenant_id: A.tenantId, quotation_type: typeId, createdAt: new Date(Date.now() - i * 1000),
      })));
    });
    test.each([[10], [25], [50], [100]])("page size %p: first and last page sizes, pages, newest first", async (n) => {
      const pages = Math.ceil(120 / n);
      const first = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&page=1&limit=${n}`);
      const last = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&page=${pages}&limit=${n}`);
      expect([first.body.data.length, first.body.total, first.body.pages, first.body.limit]).toEqual([n, 120, pages, n]);
      expect(last.body.data.length).toBe(120 - (pages - 1) * n);
      expect(first.body.data[0].number).toBe("QUO-P00000");
    });
  });

  test("stats reflect a newly created quotation (count + value)", async () => {
    const before = (await as(A.users.admin).get("/api/quotations/stats")).body;
    await as(A.users.admin).post("/api/quotations", { status: "draft", total: 1234.5, date: new Date().toISOString() });
    const after = (await as(A.users.admin).get("/api/quotations/stats")).body;
    expect([after.totalThisMonth - before.totalThisMonth, +(after.totalValue - before.totalValue).toFixed(2)]).toEqual([1, 1234.5]);
  });

  test("delete removes it (API + DB), then 404", async () => {
    const q = (await as(A.users.admin).post("/api/quotations", { status: "draft" })).body;
    const d = await as(A.users.admin).del(`/api/quotations/${q._id}`);
    expect([d.status, d.body.message]).toEqual([200, "Quotation removed"]);
    expect(await Quotation.findById(q._id)).toBeNull();
    expect((await as(A.users.admin).get(`/api/quotations/${q._id}`)).status).toBe(404);
  });
});

describe("approval flow (add-on ON)", () => {
  beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
  afterAll(() => setFeatures(A.tenantId, []));
  const approverRooms = () => [A.users.admin.id, A.users.approver.id, A.users.pilot.id].map(String).sort();

  test("request -> pending (+socket to every approver) -> listed -> approve (+socket to maker) -> can be sent -> history", async () => {
    const maker = as(A.users.maker);
    const q = (await maker.post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    expect(q.approval.status).toBe("none");

    let mark = guard.socketEvents.length;
    const req = await maker.post(`/api/quotations/${q._id}/request-approval`);
    expect([req.status, req.body.approval.status, req.body.approval.requested_by]).toEqual([200, "pending", String(A.users.maker.id)]);
    expect((await Quotation.findById(q._id).lean()).approval.status).toBe("pending");
    const reqEvents = guard.socketEvents.slice(mark);
    expect(reqEvents.map((e) => e.room).sort()).toEqual(approverRooms());
    expect(reqEvents.every((e) => e.event === "quotationApproval" && e.payload.event === "requested" && e.payload.number === q.number && e.payload.by === "maker A")).toBe(true);

    const pend = await as(A.users.approver).get("/api/quotations/approvals/pending");
    expect(pend.status).toBe(200);
    const row = pend.body.find((x) => x._id === q._id);
    expect([row?.client?.company, row?.approval?.requested_by?.firstname]).toEqual(["Cust A1", "maker"]);

    mark = guard.socketEvents.length;
    const ap = await as(A.users.approver).post(`/api/quotations/${q._id}/approve`, {});
    expect([ap.status, ap.body.approval.status, ap.body.approval.decided_by, ap.body.approval.requested_by]).toEqual([200, "approved", String(A.users.approver.id), String(A.users.maker.id)]);
    expect(guard.socketEvents.slice(mark)).toEqual([{ room: String(A.users.maker.id), event: "quotationApproval", payload: expect.objectContaining({ event: "approved", quotationId: q._id }) }]);

    const h = await maker.get(`/api/quotations/${q._id}/approval-history`);
    expect(h.body.status).toBe("approved");
    expect(h.body.history.map((s) => [s.action, s.by?.firstname])).toEqual([["requested", "maker"], ["approved", "approver"]]);
  });

  // After approval the maker marks it sent (status-only PUT, same as the UI "Save" with status "sent").
  test.each([["status only", {}], ["full payload resend", { notes: "same" }]])("maker can mark an approved quotation sent (%s)", async (_l, extra) => {
    const maker = as(A.users.maker);
    const q = (await maker.post("/api/quotations", { status: "draft", client: String(A.customers[0]._id), notes: "same" })).body;
    await maker.post(`/api/quotations/${q._id}/request-approval`);
    await as(A.users.approver).post(`/api/quotations/${q._id}/approve`, {});
    const sent = await maker.put(`/api/quotations/${q._id}`, { status: "sent", ...extra });
    expect([sent.body.status, sent.body.approval.status]).toEqual(["sent", "approved"]);
  });

  test("reject with comment -> rejected, comment stored, socket to maker, history; re-request allowed", async () => {
    const maker = as(A.users.maker);
    const q = (await maker.post("/api/quotations", { status: "draft", client: String(A.customers[2]._id) })).body;
    await maker.post(`/api/quotations/${q._id}/request-approval`);
    const mark = guard.socketEvents.length;
    const rj = await as(A.users.admin).post(`/api/quotations/${q._id}/reject`, { comment: "  Price too low  " });
    expect([rj.status, rj.body.approval.status, rj.body.approval.comment]).toEqual([200, "rejected", "Price too low"]);
    const db = await Quotation.findById(q._id).lean();
    expect([db.approval.status, db.approval.comment, db.approval_history.at(-1).comment]).toEqual(["rejected", "Price too low", "Price too low"]);
    expect(guard.socketEvents.slice(mark)).toEqual([{ room: String(A.users.maker.id), event: "quotationApproval", payload: expect.objectContaining({ event: "rejected", comment: "Price too low" }) }]);
    const again = await maker.post(`/api/quotations/${q._id}/request-approval`);
    expect([again.status, again.body.approval.status]).toEqual([200, "pending"]);
    const h = await maker.get(`/api/quotations/${q._id}/approval-history`);
    expect(h.body.history.map((s) => s.action)).toEqual(["requested", "rejected", "requested"]);
  });
});

describe("quotation types via API", () => {
  test("GET returns ALL types incl. inactive; ?activeOnly=true hides inactive; sorted by order", async () => {
    const seeded = (b) => b.map((t) => t.slug).filter((s) => ["trinetra-technoworld-pvt-ltd", "electrical", "interior"].includes(s));
    const all = await as(A.users.admin).get("/api/quotation-types");
    expect(seeded(all.body)).toEqual(["trinetra-technoworld-pvt-ltd", "electrical", "interior"]);
    const act = await as(A.users.admin).get("/api/quotation-types?activeOnly=true");
    expect(seeded(act.body)).toEqual(["trinetra-technoworld-pvt-ltd", "electrical"]);
  });

  test("create -> update -> reorder (sidebar order) -> delete (API + DB)", async () => {
    const QuotationType = require("../../models/QuotationType");
    const adm = as(A.users.admin);
    const c = await adm.post("/api/quotation-types", { name: "Home Automation", icon: "Home", format: "pro", theme: { primaryColor: "#000000" } });
    expect([c.status, c.body.slug, c.body.order, c.body.format, c.body.icon, c.body.active, c.body.theme.primaryColor, c.body.theme.roomHeaderBg])
      .toEqual([201, "home-automation", 4, "pro", "Home", true, "#000000", "#882200"]);
    const u = await adm.put(`/api/quotation-types/${c.body._id}`, { name: "Smart Home", active: false, format: "both" });
    expect([u.status, u.body.slug, u.body.active, u.body.format]).toEqual([200, "smart-home", false, "both"]);
    const ids = [c.body._id, A.types.interior._id, A.types.electrical._id, A.types.trinetra._id].map(String);
    const ro = await adm.put("/api/quotation-types/reorder", { items: ids.map((id, i) => ({ id, order: i + 1 })) });
    const mine = (b) => b.map((t) => String(t._id)).filter((id) => ids.includes(id));
    expect(mine(ro.body)).toEqual(ids);
    expect(mine((await adm.get("/api/quotation-types")).body)).toEqual(ids);
    const d = await adm.del(`/api/quotation-types/${c.body._id}`);
    expect([d.status, d.body.message]).toEqual([200, "Quotation type removed"]);
    expect(await QuotationType.findById(c.body._id)).toBeNull();
  });
});
