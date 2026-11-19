// Quotation Maker — PHASE 1 backend unit tests. Every assertion states the CORRECT
// behaviour: a failing test is a bug (or a confirmed NOTE), not a test to "fix".
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client } = require("./quotationStack.cjs");

let A, B, Quotation, QuotationType;
const as = (u) => client(u.token);

beforeAll(async () => {
  await start();
  ({ A, B } = await seedAll());
  Quotation = require("../../models/Quotation");
  QuotationType = require("../../models/QuotationType");
});
afterAll(stop);

const validErr = async (Model, doc) => {
  try { await new Model(doc).validate(); return null; } catch (e) { return e; }
};

// ───────────────────────── Quotation model ─────────────────────────
describe("Quotation model", () => {
  test("number is required", async () => {
    const e = await validErr(Quotation, {});
    expect(e && e.errors.number).toBeTruthy();
  });

  test("number is unique (duplicate insert rejected with E11000)", async () => {
    await Quotation.create({ number: "QUO-U00001", tenant_id: A.tenantId });
    await expect(Quotation.create({ number: "QUO-U00001", tenant_id: A.tenantId })).rejects.toThrow(/E11000/);
  });

  test.each([
    ["status", "draft", true], ["status", "sent", true], ["status", "pending", true], ["status", "accepted", true],
    ["status", "rejected", true], ["status", "expired", true], ["status", "approved", false], ["status", "DRAFT", false],
    ["format", "simple", true], ["format", "pro", true], ["format", "both", false],
    ["approval.status", "none", true], ["approval.status", "pending", true], ["approval.status", "approved", true],
    ["approval.status", "rejected", true], ["approval.status", "auto", false],
  ])("enum %s = %p valid=%p", async (path, value, ok) => {
    const doc = { number: "QUO-E1" };
    if (path === "approval.status") doc.approval = { status: value }; else doc[path] = value;
    const e = await validErr(Quotation, doc);
    expect(!!(e && e.errors[path])).toBe(!ok);
  });

  test.each([
    ["requested", true], ["approved", true], ["rejected", true], ["auto_approved", true], ["reset", true],
    ["pending", false], ["none", false],
  ])("approval_history.action = %p valid=%p", async (action, ok) => {
    const e = await validErr(Quotation, { number: "QUO-H1", approval_history: [{ action }] });
    expect(!!(e && e.errors["approval_history.0.action"])).toBe(!ok);
  });

  test("rooms[].name is required", async () => {
    const e = await validErr(Quotation, { number: "QUO-R1", rooms: [{ items: [] }] });
    expect(e && e.errors["rooms.0.name"]).toBeTruthy();
    expect(await validErr(Quotation, { number: "QUO-R2", rooms: [{ name: "Hall" }] })).toBeNull();
  });

  test("defaults: status draft, gst 18, currency INR, show_item_images true, format simple, totals 0", () => {
    const q = new Quotation({ number: "QUO-D1" });
    expect({ status: q.status, gst: q.gst_percent, cur: q.currency, img: q.show_item_images, fmt: q.format, sub: q.subtotal, tot: q.total, disc: q.discount_percent })
      .toEqual({ status: "draft", gst: 18, cur: "INR", img: true, fmt: "simple", sub: 0, tot: 0, disc: 0 });
    expect(q.approval?.status).toBeUndefined(); // no default on purpose (legacy quotations)
  });
});

// ───────────────────────── QuotationType model ─────────────────────────
describe("QuotationType model", () => {
  test.each([["name"], ["slug"]])("%s is required", async (f) => {
    const doc = { name: "X", slug: "x" };
    delete doc[f];
    const e = await validErr(QuotationType, doc);
    expect(e && e.errors[f]).toBeTruthy();
  });

  test("slug is lowercased + trimmed", () => {
    expect(new QuotationType({ name: "X", slug: "  ABC-Def " }).slug).toBe("abc-def");
  });

  test.each([["simple", true], ["pro", true], ["both", true], ["mixed", false]])("format %p valid=%p", async (format, ok) => {
    const e = await validErr(QuotationType, { name: "X", slug: "x", format });
    expect(!!(e && e.errors.format)).toBe(!ok);
  });

  test("unique index {tenant_id, slug}: same slug blocked in a tenant, allowed across tenants", async () => {
    const idx = await QuotationType.collection.indexes();
    expect(idx.find((i) => JSON.stringify(i.key) === JSON.stringify({ tenant_id: 1, slug: 1 }))?.unique).toBe(true);
    const t = new mongoose.Types.ObjectId();
    await QuotationType.create({ name: "Dup", slug: "dup-slug", tenant_id: t });
    await expect(QuotationType.create({ name: "Dup", slug: "dup-slug", tenant_id: t })).rejects.toThrow(/E11000/);
    await expect(QuotationType.create({ name: "Dup", slug: "dup-slug", tenant_id: new mongoose.Types.ObjectId() })).resolves.toBeTruthy();
  });
});

// ───────────────────────── quotation_type_controller ─────────────────────────
describe("quotation_type_controller", () => {
  test.each([
    ["  Home  Automation!! ", "home-automation"],
    ["Solar_Panels 2", "solar-panels-2"],
    ["UPPER case", "upper-case"],
    ["--CCTV--", "cctv"],
  ])("slugify %p -> %p", async (name, slug) => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe(slug);
    expect(r.body.tenant_id).toBe(String(A.tenantId));
  });

  test.each([
    [{}, "name is required"],
    [{ name: "" }, "name is required"],
    [{ name: null }, "name is required"],
    [{ name: "!!!" }, "name must contain at least one letter or number"],
    [{ name: "   " }, "name must contain at least one letter or number"],
    [{ name: "Electrical" }, "A quotation type with this name already exists"],
    [{ name: "  ELECTRICAL! " }, "A quotation type with this name already exists"],
  ])("create %p -> 400 %p", async (body, message) => {
    const r = await as(A.users.admin).post("/api/quotation-types", body);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(message);
  });

  test("rename onto an existing name -> 400 already exists", async () => {
    const r = await as(A.users.admin).put(`/api/quotation-types/${A.types.interior._id}`, { name: "Electrical" });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("A quotation type with this name already exists");
  });

  test.each([[{}], [{ items: [] }], [{ items: "x" }], [{ items: null }]])("reorder %p -> 400 items array is required", async (body) => {
    const r = await as(A.users.admin).put("/api/quotation-types/reorder", body);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("items array is required");
  });

  test("tenant filter on every query (B admin vs A types)", async () => {
    const b = as(B.users.admin);
    const id = A.types.electrical._id;
    const list = await b.get("/api/quotation-types");
    expect(list.body.map((t) => t.tenant_id)).toEqual(list.body.map(() => String(B.tenantId)));
    expect((await b.put(`/api/quotation-types/${id}`, { name: "Hijack" })).status).toBe(404);
    expect((await b.del(`/api/quotation-types/${id}`)).status).toBe(404);
    const re = await b.put("/api/quotation-types/reorder", { items: [{ id, order: 99 }] });
    expect(re.body.map((t) => String(t._id))).not.toContain(String(id));
    const after = await QuotationType.findById(id).lean();
    expect({ name: after.name, order: after.order }).toEqual({ name: "Electrical", order: 2 });
    // per-tenant uniqueness: B may reuse A's name
    expect((await b.post("/api/quotation-types", { name: "Electrical" })).status).toBe(201);
  });
});

// ───────────────────────── quotation_controller: create / list / stats ─────────────────────────
describe("quotation_controller (approval add-on OFF)", () => {
  beforeAll(() => setFeatures(A.tenantId, []));

  test.each([["sent"], ["pending"], ["accepted"], [undefined]])("status %p without client -> 400 client is required", async (status) => {
    const r = await as(A.users.admin).post("/api/quotations", { status });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("client is required");
  });

  test("draft without client is allowed; number is QUO-<6 digits>; tenant/created_by from token", async () => {
    const r = await as(A.users.maker).post("/api/quotations", { status: "draft" });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^QUO-\d{6}$/);
    expect(r.body.status).toBe("draft");
    expect(r.body.tenant_id).toBe(String(A.tenantId));
    expect(r.body.created_by).toBe(String(A.users.maker.id));
    expect(r.body.approval?.status).toBeUndefined();
  });

  test.each([
    ["12.5", 12.5], ["abc", 0], [null, 0], ["", 0], [100, 100], [undefined, 0],
  ])("Number(...)||0 coercion: %p -> %p on subtotal/total_tax/total/discount_percent/discount_total", async (v, want) => {
    const body = { status: "draft" };
    for (const f of ["subtotal", "total_tax", "total", "discount_percent", "discount_total"]) body[f] = v;
    const r = await as(A.users.admin).post("/api/quotations", body);
    expect(r.status).toBe(201);
    const db = await Quotation.findById(r.body._id).lean();
    for (const f of ["subtotal", "total_tax", "total", "discount_percent", "discount_total"]) {
      expect([f, r.body[f], db[f]]).toEqual([f, want, want]);
    }
  });

  describe("getQuotations", () => {
    let typeId, nums;
    beforeAll(async () => {
      typeId = (await QuotationType.create({ name: "List T", slug: "list-t", tenant_id: A.tenantId }))._id;
      const docs = await Quotation.create([1, 2, 3].map((i) => ({
        number: `QUO-L0000${i}`, tenant_id: A.tenantId, quotation_type: typeId, client: A.customers[0]._id, created_by: A.users.admin.id,
      })));
      nums = docs.map((d) => d.number);
    });

    test("no page/search -> bare array (limit alone keeps the array)", async () => {
      const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}`);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(3);
      const r2 = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&limit=2`);
      expect(Array.isArray(r2.body)).toBe(true);
      expect(r2.body.length).toBe(2);
    });

    test("page -> envelope {data,total,page,pages,limit}", async () => {
      const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&page=2&limit=2`);
      expect({ ...r.body, data: r.body.data.length }).toEqual({ data: 1, total: 3, page: 2, pages: 2, limit: 2 });
    });

    test.each([["0", 25], ["-5", 1], ["1", 1], ["500", 500], ["1000", 500], ["abc", 25], [null, 25]])(
      "limit %p clamps to %p", async (lim, want) => {
        const q = lim === null ? "" : `&limit=${lim}`;
        const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&page=1${q}`);
        expect(r.body.limit).toBe(want);
      });

    test.each([
      ["exact number", () => nums[1], 1],
      ["number fragment, case-insensitive", () => "quo-l0000", 3],
      ["client company (not searched)", () => "Cust A1", 0],
      ["regex chars are escaped", () => "QUO-.*", 0],
      ["blank search -> all", () => "  ", 3],
    ])("search on number only: %s", async (_l, term, want) => {
      const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${typeId}&search=${encodeURIComponent(term())}`);
      expect(r.body.total).toBe(want);
    });
  });

  test("getQuotationStats: this calendar month by `date`, accepted count, totalValue", async () => {
    const typeId = (await QuotationType.create({ name: "Stats T", slug: "stats-t", tenant_id: A.tenantId }))._id;
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 12);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 2, 12);
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 1);
    await Quotation.create([
      { number: "QUO-S1", tenant_id: A.tenantId, quotation_type: typeId, date: now, status: "accepted", total: 1000 },
      { number: "QUO-S2", tenant_id: A.tenantId, quotation_type: typeId, date: firstOfMonth, status: "sent", total: 250.5 },
      { number: "QUO-S3", tenant_id: A.tenantId, quotation_type: typeId, date: lastMonth, status: "accepted", total: 7000 },
      { number: "QUO-S4", tenant_id: A.tenantId, quotation_type: typeId, date: nextMonth, status: "accepted", total: 9000 },
      { number: "QUO-S5", tenant_id: B.tenantId, quotation_type: typeId, date: now, status: "accepted", total: 5000 },
    ]);
    const r = await as(A.users.admin).get(`/api/quotations/stats?quotation_type=${typeId}`);
    expect(r.body).toEqual({ totalThisMonth: 2, acceptedThisMonth: 1, totalValue: 1250.5 });
  });

  test.each([
    ["request-approval", "post"], ["approve", "post"], ["reject", "post"],
  ])("add-on OFF: %s -> 403 FEATURE_DISABLED", async (ep) => {
    const q = await Quotation.create({ number: `QUO-OFF-${ep}`, tenant_id: A.tenantId, client: A.customers[0]._id });
    const r = await as(A.users.admin).post(`/api/quotations/${q._id}/${ep}`, { comment: "x" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ code: "FEATURE_DISABLED", message: "Quotation approval is not enabled for your account" });
  });

  test("add-on OFF: pending list -> 403 FEATURE_DISABLED; non-approver may save status sent", async () => {
    const r = await as(A.users.admin).get("/api/quotations/approvals/pending");
    expect([r.status, r.body.code]).toEqual([403, "FEATURE_DISABLED"]);
    const c = await as(A.users.maker).post("/api/quotations", { status: "sent", client: A.customers[0]._id });
    expect([c.status, c.body.status, c.body.approval?.status]).toEqual([201, "sent", undefined]);
  });
});

// ───────────────────────── approval flow (add-on ON) ─────────────────────────
describe("quotation_controller approval flow (add-on ON)", () => {
  beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
  afterAll(() => setFeatures(A.tenantId, []));
  const mkQ = async (user, body = {}) => (await as(user).post("/api/quotations", { client: A.customers[0]._id, status: "draft", ...body })).body;
  const setApproval = (id, status) => Quotation.updateOne({ _id: id }, { $set: { "approval.status": status } });

  test.each([["approver"], ["admin"], ["pilot"]])("%s create -> approved + history auto_approved, status kept", async (who) => {
    const q = await mkQ(A.users[who], { status: "sent" });
    expect(q.status).toBe("sent");
    expect(q.approval.status).toBe("approved");
    expect(q.approval.decided_by).toBe(String(A.users[who].id));
    expect(q.approval_history.map((h) => h.action)).toEqual(["auto_approved"]);
  });

  test.each([["sent", "draft"], ["pending", "draft"], ["accepted", "draft"], ["draft", "draft"], ["rejected", "rejected"], ["expired", "expired"]])(
    "non-approver create with status %p -> saved %p, approval none", async (status, saved) => {
      const q = await mkQ(A.users.maker, { status });
      expect([q.status, q.approval.status, q.approval_history.length]).toEqual([saved, "none", 0]);
    });

  test.each([["approved", "Edited after approval"], ["rejected", "Edited after rejection"]])(
    "non-approver edit of %s -> approval none + history reset, sent forced to draft, contact/address kept", async (cur, comment) => {
      const q = await mkQ(A.users.approver);
      await setApproval(q._id, cur);
      const r = await as(A.users.maker).put(`/api/quotations/${q._id}`, { status: "sent", contact_number: "9999911111", client_address: "Edited addr" });
      expect(r.status).toBe(200);
      expect(r.body.approval.status).toBe("none");
      const last = r.body.approval_history[r.body.approval_history.length - 1];
      expect([last.action, last.comment, last.by]).toEqual(["reset", comment, String(A.users.maker.id)]);
      expect([r.body.status, r.body.contact_number, r.body.client_address]).toEqual(["draft", "9999911111", "Edited addr"]);
    });

  test("approver edit of approved keeps approval and may set sent", async () => {
    const q = await mkQ(A.users.approver);
    const r = await as(A.users.approver).put(`/api/quotations/${q._id}`, { status: "sent" });
    expect([r.body.status, r.body.approval.status, r.body.approval_history.length]).toEqual(["sent", "approved", 1]);
  });

  test.each([
    ["pending", true, "Approval already requested"],
    ["approved", true, "Quotation is already approved"],
    ["none", false, "Select a customer before requesting approval"],
  ])("request-approval when %s (client=%p) -> 400 %p", async (cur, withClient, message) => {
    const q = withClient ? await mkQ(A.users.maker) : await mkQ(A.users.maker, { client: undefined });
    await setApproval(q._id, cur);
    const r = await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    expect([r.status, r.body.message]).toEqual([400, message]);
  });

  test.each([
    ["pending", "", "Please give a reason for rejecting"],
    ["pending", "   ", "Please give a reason for rejecting"],
    ["none", "too costly", "Only quotations awaiting approval can be rejected"],
    ["approved", "too costly", "Only quotations awaiting approval can be rejected"],
    ["rejected", "again", "Only quotations awaiting approval can be rejected"],
  ])("reject when %s with comment %p -> 400 %p", async (cur, comment, message) => {
    const q = await mkQ(A.users.maker);
    await setApproval(q._id, cur);
    const r = await as(A.users.approver).post(`/api/quotations/${q._id}/reject`, { comment });
    expect([r.status, r.body.message]).toEqual([400, message]);
  });

  test.each([
    ["maker", "post", "approve"], ["maker", "post", "reject"], ["noPerm", "post", "approve"],
    ["settingsView", "post", "approve"], ["maker", "get", "pending"],
  ])("non-approver %s %s %s -> 403", async (who, method, ep) => {
    const q = await mkQ(A.users.maker);
    await setApproval(q._id, "pending");
    const path = ep === "pending" ? "/api/quotations/approvals/pending" : `/api/quotations/${q._id}/${ep}`;
    const r = await as(A.users[who])[method](path, method === "post" ? { comment: "x" } : undefined);
    expect([r.status, r.body.message]).toEqual([403, "You don't have permission to approve quotations"]);
  });
});

// ───────────────────────── NOTE claims ─────────────────────────
describe("NOTE claims", () => {
  beforeAll(() => setFeatures(A.tenantId, []));

  // quotation_controller.js:11-16 says "Each admin/staff sees only THEIR OWN quotations".
  test.each([["list"], ["get"], ["stats"]])("NOTE ownerFilter: another staff cannot see maker's quotation (%s)", async (op) => {
    const t = (await QuotationType.create({ name: `Own ${op}`, slug: `own-${op}`, tenant_id: A.tenantId }))._id;
    const q = (await as(A.users.maker).post("/api/quotations", { client: A.customers[0]._id, status: "sent", quotation_type: t, total: 500 })).body;
    const other = as(A.users.settingsView);
    if (op === "list") {
      const r = await other.get(`/api/quotations?quotation_type=${t}`);
      expect(r.body.map((x) => x._id)).not.toContain(q._id);
    } else if (op === "get") {
      expect((await other.get(`/api/quotations/${q._id}`)).status).toBe(404);
    } else {
      expect((await other.get(`/api/quotations/stats?quotation_type=${t}`)).body.totalThisMonth).toBe(0);
    }
  });

  test.each([
    ["same tenant", "A", "A"],
    ["across tenants", "A", "B"],
  ])("NOTE number collision (%s): second create still succeeds with a unique number", async (_l, t1, t2) => {
    const tok = { A: A.users.admin, B: B.users.admin };
    const spy = jest.spyOn(Math, "random").mockReturnValue(t2 === "A" ? 0.25 : 0.75);
    try {
      const r1 = await as(tok[t1]).post("/api/quotations", { status: "draft" });
      const r2 = await as(tok[t2]).post("/api/quotations", { status: "draft" });
      expect(r1.status).toBe(201);
      expect([r2.status, r2.body?.message]).toEqual([201, undefined]);
      expect(r2.body.number).not.toBe(r1.body.number);
    } finally { spy.mockRestore(); }
  });

  test.each([
    ["simple items", { items: [{ description: "Bulb", qty: 2, rate: 100 }], gst_percent: 18 }, { subtotal: 200, total_tax: 36, total: 236 }],
    ["pro rooms", { format: "pro", rooms: [{ name: "Hall", items: [{ description: "Switch", unit_price: 100, qty: 3 }] }], gst_percent: 18 }, { subtotal: 300, total_tax: 54, total: 354 }],
  ])("NOTE totals: server recomputes subtotal/total_tax/total from %s", async (_l, body, want) => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", ...body, subtotal: 1, total_tax: 1, total: 1 });
    expect({ subtotal: r.body.subtotal, total_tax: r.body.total_tax, total: r.body.total }).toEqual(want);
  });
});
