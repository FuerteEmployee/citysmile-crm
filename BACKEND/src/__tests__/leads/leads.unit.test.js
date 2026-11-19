// Leads module — backend UNIT tests (model rules + controller logic).
// In-memory MongoDB + faked Graph API / nodemailer only (see leadsStack.cjs).
// A failing test = a bug: each assertion states the CORRECT expected behaviour.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client, guard, graph } = require("./leadsStack.cjs");

let A, B, api, apiB;
let Lead, LeadStatus, LeadSource, Client, Contact, LeadConversion, CustomField, CustomFieldValue, Reminder, Staff, Item;
let ctrl, webhookCtrl;

// Minimal Express-like req/res for calling controllers directly.
const mkRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.sendStatus = (c) => { res.statusCode = c; return res; };
  return res;
};
const call = async (fn, { user, params = {}, query = {}, body = {}, permissionLevel = "global" }) => {
  const res = mkRes();
  await fn({ user, params, query, body, permissionLevel, headers: {}, ip: "127.0.0.1", app: { get: () => null } }, res);
  return res;
};
const oid = () => new mongoose.Types.ObjectId();
const s = (v) => (v == null ? v : String(v));
const tA = () => ({ tenant_id: A.tenantId });
const mkLead = (extra = {}) => Lead.create({ name: `U ${Math.random().toString(36).slice(2, 9)}`, tenant_id: A.tenantId, ...extra });

beforeAll(async () => {
  await start();
  ({ A, B } = await seedAll());
  Lead = require("../../models/Lead");
  LeadStatus = require("../../models/LeadStatus");
  LeadSource = require("../../models/LeadSource");
  Client = require("../../models/Client");
  Contact = require("../../models/Contact");
  LeadConversion = require("../../models/LeadConversion");
  CustomField = require("../../models/CustomField");
  CustomFieldValue = require("../../models/CustomFieldValue");
  Reminder = require("../../models/Reminder");
  Staff = require("../../models/Staff");
  Item = require("../../models/Item");
  ctrl = require("../../controllers/lead_controller");
  webhookCtrl = require("../../controllers/webhook_controller");
  await Promise.all([LeadConversion.init(), Client.init(), LeadStatus.init(), LeadSource.init()]);
  await Lead.init().catch(() => {}); // index build result is asserted in its own test
  api = client(A.users.admin.token);
  apiB = client(B.users.admin.token);
});
afterAll(async () => {
  expect(guard.realFacebookCalls).toBe(0);
  await stop();
});

// ───────────────────────────── Lead model ─────────────────────────────
describe("Lead model", () => {
  test("[unit] name is required", () => {
    const err = new Lead({}).validateSync();
    expect(err.errors.name).toBeDefined();
  });
  test("[unit] name is trimmed", () => {
    expect(new Lead({ name: "  Bob Lead  " }).name).toBe("Bob Lead");
  });
  test("[unit] email is trimmed and lowercased", () => {
    expect(new Lead({ name: "x", email: "  John.DOE@Example.COM " }).email).toBe("john.doe@example.com");
  });
  test("[unit] status / source / assigned / addedfrom are ObjectId refs", () => {
    const refs = { status: "LeadStatus", source: "LeadSource", assigned: "Staff", addedfrom: "Staff" };
    for (const [path, ref] of Object.entries(refs)) {
      const p = Lead.schema.path(path);
      expect(p.instance).toBe("ObjectId");
      expect(p.options.ref).toBe(ref);
    }
    expect(new Lead({ name: "x", status: "not-an-id" }).validateSync().errors.status).toBeDefined();
  });
  test("[unit] defaults: lead_value '0', English, is_public/junk/lost/converted false", () => {
    const l = new Lead({ name: "Defaults" });
    expect(l.lead_value).toBe("0");
    expect(l.default_language).toBe("English");
    expect(l.is_public).toBe(false);
    expect(l.junk).toBe(false);
    expect(l.lost).toBe(false);
    expect(l.converted).toBe(false);
    expect(l.followup_notified).toBe(false);
  });
  test("[unit] pre-save sets phone_last10 to the last 10 digits", async () => {
    const l = await mkLead({ phonenumber: "+91 (98765) 43-210" });
    expect(l.phone_last10).toBe("9876543210");
    l.phonenumber = "0091 99999 88888";
    await l.save();
    expect((await Lead.findById(l._id)).phone_last10).toBe("9999988888");
  });
  test("[unit] pre-save leaves phone_last10 undefined for < 10 digits / no phone", async () => {
    expect((await mkLead({ phonenumber: "12345" })).phone_last10).toBeUndefined();
    expect((await mkLead({})).phone_last10).toBeUndefined();
  });
  test("[unit] index uniq_whatsapp_lead_per_phone exists, unique, only for origin whatsapp", async () => {
    const idx = (await Lead.collection.indexes()).find((i) => i.name === "uniq_whatsapp_lead_per_phone");
    expect(idx).toBeDefined();
    expect(idx.unique).toBe(true);
    expect(idx.partialFilterExpression.origin).toBe("whatsapp");
  });
  test("[unit] two WhatsApp leads with the same number in one tenant → duplicate key", async () => {
    await mkLead({ phonenumber: "9000000001", origin: "whatsapp" });
    await expect(mkLead({ phonenumber: "+91 9000000001", origin: "whatsapp" })).rejects.toMatchObject({ code: 11000 });
  });
  test("[unit] same number allowed for non-WhatsApp leads and across tenants", async () => {
    await mkLead({ phonenumber: "9000000002" });
    await expect(mkLead({ phonenumber: "9000000002" })).resolves.toBeDefined();
    await mkLead({ phonenumber: "9000000003", origin: "whatsapp" });
    await expect(Lead.create({ name: "B wa", tenant_id: B.tenantId, phonenumber: "9000000003", origin: "whatsapp" })).resolves.toBeDefined();
  });
});

// ───────────────────────────── stripProtected ─────────────────────────────
describe("stripProtected (create / update / import)", () => {
  const protectedPayload = () => ({
    tenant_id: String(B.tenantId),
    converted: true,
    converted_at: "2020-01-01T00:00:00Z",
    client_id: String(oid()),
    origin: "whatsapp",
    phone_last10: "0000000000",
    meta_ad_id: "AD_FAKE",
    whatsapp_wa_id: "wa-fake",
    whatsapp_first_message: "hi",
    whatsapp_last_message: "bye",
    whatsapp_last_message_at: "2020-01-01T00:00:00Z",
    whatsapp_message_count: 7,
    createdAt: "2000-01-01T00:00:00Z",
    updatedAt: "2000-01-01T00:00:00Z",
  });
  const expectClean = (doc) => {
    expect(s(doc.tenant_id)).toBe(s(A.tenantId));
    expect(doc.converted).toBe(false);
    expect(doc.converted_at).toBeUndefined();
    expect(doc.client_id).toBeUndefined();
    expect(doc.origin).toBe("");
    expect(doc.phone_last10).not.toBe("0000000000");
    expect(doc.meta_ad_id).toBeUndefined();
    expect(doc.whatsapp_wa_id).toBeUndefined();
    expect(doc.whatsapp_first_message).toBeUndefined();
    expect(doc.whatsapp_last_message).toBeUndefined();
    expect(doc.whatsapp_last_message_at).toBeUndefined();
    expect(doc.whatsapp_message_count).toBe(0);
    expect(doc.createdAt.getFullYear()).toBeGreaterThan(2020);
  };

  test("[unit] create ignores protected fields and a client-chosen _id", async () => {
    const forcedId = oid();
    const r = await api.post("/api/leads", { name: "Strip Create", phonenumber: "9811111111", _id: String(forcedId), ...protectedPayload() });
    expect(r.status).toBe(201);
    expect(s(r.body._id)).not.toBe(s(forcedId));
    const doc = await Lead.findById(r.body._id);
    expectClean(doc);
    expect(doc.phone_last10).toBe("9811111111");
  });
  test("[unit] create ignores a client-sent `id` (alias of _id)", async () => {
    const forcedId = oid();
    const r = await api.post("/api/leads", { name: "Strip Create id", id: String(forcedId) });
    expect(r.status).toBe(201);
    expect(s(r.body._id)).not.toBe(s(forcedId));
  });
  test("[unit] update ignores protected fields", async () => {
    const lead = await mkLead({ name: "Strip Update", phonenumber: "9822222222" });
    const r = await api.put(`/api/leads/${lead._id}`, { city: "Surat", ...protectedPayload() });
    expect(r.status).toBe(200);
    const doc = await Lead.findById(lead._id);
    expect(doc.city).toBe("Surat");
    expectClean(doc);
  });
  test("[unit] import ignores protected fields", async () => {
    const r = await api.post("/api/leads/import", [{ name: "Strip Import Row", ...protectedPayload() }]);
    expect(r.status).toBe(201);
    const doc = await Lead.findOne({ name: "Strip Import Row" });
    expect(doc).not.toBeNull();
    expectClean(doc);
  });
});

// ───────────────────────────── createLead ─────────────────────────────
describe("createLead", () => {
  test("[unit] invalid status / source / assigned ids are dropped (no CastError)", async () => {
    const r = await api.post("/api/leads", { name: "Bad Ids", status: "abc", source: "", assigned: "xyz" });
    expect(r.status).toBe(201);
    const doc = await Lead.findById(r.body._id);
    expect(doc.status).toBeUndefined();
    expect(doc.source).toBeUndefined();
    expect(doc.assigned).toBeUndefined();
  });
  test("[unit] addedfrom defaults to the caller", async () => {
    const r = await client(A.users.full.token).post("/api/leads", { name: "Added By Full" });
    expect(r.status).toBe(201);
    expect(s((await Lead.findById(r.body._id)).addedfrom)).toBe(s(A.users.full.id));
  });
  test("[unit] client-sent addedfrom is ignored — creator is always the caller", async () => {
    const r = await client(A.users.full.token).post("/api/leads", { name: "Faked Creator", addedfrom: String(A.users.admin.id) });
    expect(r.status).toBe(201);
    expect(s((await Lead.findById(r.body._id)).addedfrom)).toBe(s(A.users.full.id));
  });
  test("[unit] create: status / source / assigned of another tenant are not stored", async () => {
    const r = await api.post("/api/leads", {
      name: "Cross Tenant Refs", status: String(B.statuses.New), source: String(B.sources.Website), assigned: String(B.users.full.id),
    });
    expect(r.status).toBeLessThan(500);
    const doc = r.status === 201 ? await Lead.findById(r.body._id) : null;
    if (doc) {
      expect(s(doc.status)).not.toBe(s(B.statuses.New));
      expect(s(doc.source)).not.toBe(s(B.sources.Website));
      expect(s(doc.assigned)).not.toBe(s(B.users.full.id));
    }
  });
  test("[unit] update: status / source of another tenant are not stored", async () => {
    const lead = await mkLead({ status: A.statuses.New });
    await api.put(`/api/leads/${lead._id}`, { status: String(B.statuses.Contacted), source: String(B.sources.Facebook) });
    const doc = await Lead.findById(lead._id);
    expect(s(doc.status)).not.toBe(s(B.statuses.Contacted));
    expect(s(doc.source)).not.toBe(s(B.sources.Facebook));
  });
  test("[unit] create without a name → 400 ValidationError", async () => {
    const r = await api.post("/api/leads", { email: "noname@x.test" });
    expect(r.status).toBe(400);
  });
  test("[unit] a 500 from createLead never sends the server stack trace", async () => {
    // tenant_id that cannot be cast makes the settings lookup throw a CastError (→ 500 branch).
    const r = await call(ctrl.createLead, { user: { _id: A.users.admin.id, tenant_id: "not-an-object-id", admin: true }, body: { name: "Boom" } });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toHaveProperty("stack");
  });
});

// ───────────────────────────── getLeads ─────────────────────────────
describe("getLeads", () => {
  const countA = (q = {}) => Lead.countDocuments({ ...tA(), ...q });

  test("[unit] legacy (no page/limit/search) → bare array of all tenant leads", async () => {
    const r = await api.get("/api/leads");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(await countA());
    expect(r.body.every((l) => s(l.tenant_id) === s(A.tenantId))).toBe(true);
  });
  test("[unit] paginated → {data,total,page,pages,limit,statusCounts}", async () => {
    const r = await api.get("/api/leads?page=1");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["data", "limit", "page", "pages", "statusCounts", "total"]);
    expect(r.body.limit).toBe(25);
    expect(r.body.total).toBe(await countA());
    expect(r.body.pages).toBe(Math.ceil(r.body.total / 25));
  });
  test("[unit] search alone switches to paginated mode", async () => {
    const r = await api.get("/api/leads?search=");
    expect(Array.isArray(r.body)).toBe(false);
    expect(r.body.data).toBeDefined();
  });
  test("[unit] limit is clamped to 1..500", async () => {
    expect((await api.get("/api/leads?limit=1000")).body.limit).toBe(500);
    expect((await api.get("/api/leads?limit=-5")).body.limit).toBe(1);
    expect((await api.get("/api/leads?limit=abc")).body.limit).toBe(25);
    expect((await api.get("/api/leads?limit=3")).body.data.length).toBe(3);
  });
  test("[unit] search escapes regex metacharacters (no 500, literal match)", async () => {
    for (const q of ["(", "[", "*", "a+b?", "\\"]) {
      const r = await api.get(`/api/leads?search=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
    }
    await mkLead({ name: "Rx (special) .* lead" });
    const r = await api.get(`/api/leads?search=${encodeURIComponent("(special) .*")}`);
    expect(r.body.total).toBe(1);
  });
  test("[unit] search matches status name, source name and assigned staff name", async () => {
    const byStatus = await api.get("/api/leads?search=Confirmed&limit=500");
    expect(byStatus.body.total).toBe(await countA({ status: A.statuses.Confirmed }));
    const bySource = await api.get("/api/leads?search=Facebook&limit=500");
    expect(bySource.body.total).toBe(await countA({ source: A.sources.Facebook }));
    const byStaff = await api.get("/api/leads?search=ownView&limit=500");
    expect(byStaff.body.total).toBe(await countA({ assigned: A.users.ownView.id }));
  });
  test("[unit] search never returns another tenant's leads", async () => {
    const r = await api.get("/api/leads?search=Lead%20B&limit=500");
    expect(r.body.total).toBe(0);
  });
  test("[unit] filters status / source / assigned / unassigned", async () => {
    expect((await api.get(`/api/leads?limit=500&status=${A.statuses.Contacted}`)).body.total).toBe(await countA({ status: A.statuses.Contacted }));
    expect((await api.get(`/api/leads?limit=500&source=${A.sources.WhatsApp}`)).body.total).toBe(await countA({ source: A.sources.WhatsApp }));
    expect((await api.get(`/api/leads?limit=500&assigned=${A.users.full.id}`)).body.total).toBe(await countA({ assigned: A.users.full.id }));
    expect((await api.get("/api/leads?limit=500&assigned=unassigned")).body.total).toBe(await countA({ assigned: null }));
    expect((await api.get("/api/leads?limit=500&status=all")).body.total).toBe(await countA());
  });
  test("[unit] filters metaForm / campaign / whatsapp", async () => {
    await mkLead({ meta_form_id: "FORM_UNIT_X", campaign: "Diwali Camp" });
    await mkLead({ origin: "whatsapp", phonenumber: "9000000111" });
    expect((await api.get("/api/leads?limit=500&metaForm=FORM_UNIT_X")).body.total).toBe(1);
    expect((await api.get(`/api/leads?limit=500&campaign=${encodeURIComponent("Diwali Camp")}`)).body.total).toBe(1);
    const wa = await countA({ $or: [{ origin: "whatsapp" }, { source: A.sources.WhatsApp }] });
    expect((await api.get("/api/leads?limit=500&whatsapp=1")).body.total).toBe(wa);
  });
  test("[unit] filter converted yes / no", async () => {
    expect((await api.get("/api/leads?limit=500&converted=yes")).body.total).toBe(await countA({ converted: true }));
    expect((await api.get("/api/leads?limit=500&converted=no")).body.total).toBe(await countA({ converted: { $ne: true } }));
  });
  test("[unit] filter dateFrom / dateTo on createdAt", async () => {
    const old = await mkLead({ name: "Dated Old Lead" });
    await Lead.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date("2025-01-15T10:00:00Z") } });
    const r = await api.get("/api/leads?dateFrom=2025-01-01&dateTo=2025-01-31&limit=500");
    expect(r.body.total).toBe(1);
    expect(s(r.body.data[0]._id)).toBe(s(old._id));
    const r2 = await api.get("/api/leads?dateFrom=2025-02-01&limit=500");
    expect(r2.body.data.some((l) => s(l._id) === s(old._id))).toBe(false);
  });
  test("[unit] filter reminder today / overdue / upcoming / any / none", async () => {
    const { dayRange } = require("../../utils/appDate");
    const { start: dStart, end: dEnd } = dayRange();
    const [lt, lo, lu, ld] = await Promise.all([mkLead(), mkLead(), mkLead(), mkLead()]);
    const rem = (lead, date, status = "pending") => Reminder.create({
      description: "r", date, rel_id: lead._id, rel_type: "lead", staff: A.users.admin.id, creator: A.users.admin.id, tenant_id: A.tenantId, status,
    });
    await rem(lt, new Date((dStart.getTime() + dEnd.getTime()) / 2));
    await rem(lo, new Date(dStart.getTime() - 2 * 86400000));
    await rem(lu, new Date(dEnd.getTime() + 2 * 86400000));
    await rem(ld, new Date(dEnd.getTime() + 86400000), "completed"); // done → not pending
    const ids = async (bucket) => (await api.get(`/api/leads?reminder=${bucket}&limit=500`)).body.data.map((l) => s(l._id));
    expect(await ids("today")).toEqual([s(lt._id)]);
    expect(await ids("overdue")).toEqual([s(lo._id)]);
    expect(await ids("upcoming")).toEqual([s(lu._id)]);
    expect((await ids("any")).sort()).toEqual([s(lt._id), s(lo._id), s(lu._id)].sort());
    const none = await ids("none");
    expect(none).toContain(s(ld._id));
    expect(none).not.toContain(s(lt._id));
  });
});

// ───────────────────────────── importLeads ─────────────────────────────
describe("importLeads", () => {
  test("[unit] status / source given by NAME are mapped to this tenant's ids", async () => {
    const r = await api.post("/api/leads/import", [{ name: "Imp Map One", status: " contacted ", source: "FACEBOOK" }]);
    expect(r.status).toBe(201);
    const doc = await Lead.findOne({ name: "Imp Map One" });
    expect(s(doc.status)).toBe(s(A.statuses.Contacted));
    expect(s(doc.source)).toBe(s(A.sources.Facebook));
    expect(s(doc.tenant_id)).toBe(s(A.tenantId));
  });
  test("[unit] unknown status / source names are dropped", async () => {
    await api.post("/api/leads/import", [{ name: "Imp Map Unknown", status: "Nope", source: "Nowhere" }]);
    const doc = await Lead.findOne({ name: "Imp Map Unknown" });
    expect(doc.status).toBeUndefined();
    expect(doc.source).toBeUndefined();
  });
  test("[unit] duplicates by email OR name (case-insensitive) are skipped, counts in message", async () => {
    const r = await api.post("/api/leads/import", [
      { name: "lead a00" }, // name of seeded "Lead A00"
      { name: "Some New Person", email: "LEAD2.A@EXAMPLE.COM" }, // email of seeded lead 2
      { name: "Imp Fresh Row" },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(1);
    expect(r.body.skipped).toBe(2);
    expect(r.body.message).toBe("Imported 1 new lead(s), skipped 2 duplicate(s).");
    expect(await Lead.countDocuments({ name: "Some New Person" })).toBe(0);
  });
  test("[unit] a lead with the same name in ANOTHER tenant is not a duplicate", async () => {
    const r = await api.post("/api/leads/import", [{ name: "Lead B05" }]);
    expect(r.status).toBe(201);
    expect(await Lead.countDocuments({ name: "Lead B05", tenant_id: A.tenantId })).toBe(1);
  });
  test("[unit] name with regex characters 'a(b' is imported (no 500)", async () => {
    const r = await api.post("/api/leads/import", [{ name: "Imp a(b" }]);
    expect(r.status).toBe(201);
    expect(await Lead.countDocuments({ name: "Imp a(b" })).toBe(1);
  });
  test("[unit] name '*' is imported (no 500)", async () => {
    const r = await api.post("/api/leads/import", [{ name: "*" }]);
    expect(r.status).toBe(201);
  });
  test("[unit] a row without a name → clean 4xx / skipped row, not a 500 TypeError", async () => {
    const r = await api.post("/api/leads/import", [{ email: "noname.row@x.test" }, { name: "Imp With Name Ok" }]);
    expect(r.status).toBeLessThan(500);
    expect(String(r.body?.message || "")).not.toMatch(/Cannot read properties/);
  });
  test("[unit] status that is ANOTHER tenant's ObjectId is not kept", async () => {
    await api.post("/api/leads/import", [{ name: "Imp Cross Status", status: String(B.statuses.Confirmed), source: String(B.sources.WhatsApp) }]);
    const doc = await Lead.findOne({ name: "Imp Cross Status" });
    expect(doc).not.toBeNull();
    expect(s(doc.status)).not.toBe(s(B.statuses.Confirmed));
    expect(s(doc.source)).not.toBe(s(B.sources.WhatsApp));
  });
  test("[unit] caller with no tenant_id: duplicate check does not look at other tenants", async () => {
    // Admin user that has no company (e.g. healTenantId could not link one).
    const user = { _id: oid(), admin: true, tenant_id: undefined };
    const r = await call(ctrl.importLeads, { user, body: [{ name: "Lead B07" }] });
    const reportedAsExisting = r.body?.count === 0 && /already exist/.test(String(r.body?.message));
    expect(reportedAsExisting).toBe(false);
  });
  test("[unit] two rows with the same email inside ONE file → only one inserted", async () => {
    const r = await api.post("/api/leads/import", [
      { name: "Imp Twin One", email: "twin@import.test" },
      { name: "Imp Twin Two", email: "TWIN@import.test" },
    ]);
    expect(r.status).toBeLessThan(300);
    expect(await Lead.countDocuments({ ...tA(), email: "twin@import.test" })).toBe(1);
  });
  test("[unit] imported leads get phone_last10 (same as created leads)", async () => {
    await api.post("/api/leads/import", [{ name: "Imp Phone Row", phonenumber: "+91 98765 12121" }]);
    const doc = await Lead.findOne({ name: "Imp Phone Row" });
    expect(doc.phone_last10).toBe("9876512121");
  });
  test("[unit] empty body → 400", async () => {
    expect((await api.post("/api/leads/import", [])).status).toBe(400);
  });
});

// ───────────────────────────── convertToCustomer ─────────────────────────────
describe("convertToCustomer", () => {
  afterEach(() => setFeatures(A.tenantId, []));

  test("[unit] legacy path (no patient_conversion): Client + primary Contact, Customer status, no LeadConversion", async () => {
    const lead = await mkLead({ name: "Conv Legacy Person", email: "conv.legacy@x.test", company: "Conv Legacy Co", status: A.statuses.New });
    const r = await api.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    const doc = await Lead.findById(lead._id);
    expect(doc.converted).toBe(true);
    expect(doc.converted_at).toBeInstanceOf(Date);
    expect(s(doc.status)).toBe(s(A.statuses.Customer));
    const cl = await Client.findById(doc.client_id);
    expect(cl.company).toBe("Conv Legacy Co");
    expect(s(cl.tenant_id)).toBe(s(A.tenantId));
    const contact = await Contact.findOne({ userid: cl._id });
    expect(contact.is_primary).toBe(true);
    expect(contact.firstname).toBe("Conv");
    expect(contact.lastname).toBe("Legacy Person");
    expect(await LeadConversion.countDocuments({ lead: lead._id })).toBe(0);
  });
  test("[unit] no primary Contact when the lead has no email", async () => {
    const lead = await mkLead({ name: "Conv No Email" });
    const r = await api.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    expect(await Contact.countDocuments({ userid: r.body.client._id })).toBe(0);
  });
  test("[unit] reuses an existing Client with the same phoneE164", async () => {
    const existing = await Client.create({ company: "Phone Reuse Co", phonenumber: "+91 99887 76655", tenant_id: A.tenantId });
    const before = await Client.countDocuments(tA());
    const lead = await mkLead({ name: "Conv Phone Reuse", phonenumber: "9988776655" });
    const r = await api.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    expect(s(r.body.client._id)).toBe(s(existing._id));
    expect(await Client.countDocuments(tA())).toBe(before);
  });
  test("[unit] already converted → 409", async () => {
    const r = await api.post(`/api/leads/${A.leads[9]}/convert`, {}); // seeded converted
    expect(r.status).toBe(409);
  });

  describe("treatment path (patient_conversion on)", () => {
    beforeEach(() => setFeatures(A.tenantId, ["patient_conversion"]));
    const bad = [
      ["negative amount", { treatment_name: "X", treatment_amount: -1 }],
      ["amount > 100000000", { treatment_name: "X", treatment_amount: 100000001 }],
      ["NaN amount", { treatment_name: "X", treatment_amount: "abc" }],
      ["converted_at in the future", { treatment_name: "X", treatment_amount: 10, converted_at: new Date(Date.now() + 86400000).toISOString() }],
      ["invalid treatment_item", { treatment_amount: 10, treatment_item: "xyz" }],
      ["no treatment name / item", { treatment_amount: 10 }],
    ];
    test.each(bad)("[unit] %s → 400", async (_label, body) => {
      const lead = await mkLead();
      const r = await api.post(`/api/leads/${lead._id}/convert`, body);
      expect(r.status).toBe(400);
      expect((await Lead.findById(lead._id)).converted).toBe(false);
    });
    test("[unit] treatment_item of another tenant → 400", async () => {
      const lead = await mkLead();
      const r = await api.post(`/api/leads/${lead._id}/convert`, { treatment_item: String(B.items[0]), treatment_amount: 10 });
      expect(r.status).toBe(400);
    });
    test("[unit] valid → LeadConversion with item name, rounded amount, snapshots", async () => {
      const lead = await mkLead({ name: "Conv Treat", source: A.sources.WhatsApp, assigned: A.users.full.id, campaign: "Camp T" });
      const at = new Date(Date.now() - 3600000).toISOString();
      const r = await api.post(`/api/leads/${lead._id}/convert`, { treatment_item: String(A.items[0]), treatment_amount: "4999.999", notes: "n", converted_at: at });
      expect(r.status).toBe(201);
      const conv = await LeadConversion.findOne({ lead: lead._id });
      expect(conv.treatment_name).toBe("Root Canal A");
      expect(conv.treatment_amount).toBe(5000);
      expect(conv.source_name).toBe("WhatsApp");
      expect(conv.is_whatsapp).toBe(true);
      expect(conv.campaign).toBe("Camp T");
      expect(s(conv.assigned)).toBe(s(A.users.full.id));
      expect(conv.converted_at.toISOString()).toBe(at);
      const doc = await Lead.findById(lead._id);
      expect(doc.converted).toBe(true);
      expect(s(doc.status)).toBe(s(A.statuses.Customer));
      expect(await api.post(`/api/leads/${lead._id}/convert`, { treatment_name: "Again", treatment_amount: 1 }).then((x) => x.status)).toBe(409);
    });
    test("[unit] rolls back the new Client when the conversion record cannot be written", async () => {
      const lead = await mkLead({ name: "Conv Rollback Person", company: "Rollback Co" });
      await LeadConversion.create({ tenant_id: A.tenantId, lead: lead._id, treatment_name: "Pre", treatment_amount: 1 });
      const r = await api.post(`/api/leads/${lead._id}/convert`, { treatment_name: "T", treatment_amount: 5 });
      expect(r.status).toBe(409);
      expect(await Client.countDocuments({ ...tA(), company: "Rollback Co" })).toBe(0);
    });
  });
});

// ───────────────────────────── bulkConvertToCustomer ─────────────────────────────
describe("bulkConvertToCustomer", () => {
  afterEach(() => setFeatures(A.tenantId, []));

  test("[unit] skips converted leads, reports converted/skipped counts", async () => {
    const l1 = await mkLead({ name: "Bulk C One" });
    const l2 = await mkLead({ name: "Bulk C Two" });
    const r = await api.post("/api/leads/bulk-convert", { ids: [String(l1._id), String(l2._id), String(A.leads[19])] });
    expect(r.status).toBe(200);
    expect(r.body.convertedCount).toBe(2);
    expect(r.body.skippedCount).toBe(1);
    expect((await Lead.findById(l1._id)).converted).toBe(true);
    expect(await LeadConversion.countDocuments({ lead: l1._id })).toBe(0);
  });
  test("[unit] with patient_conversion: 'Bulk Converted', amount = Number(lead_value) || 0", async () => {
    await setFeatures(A.tenantId, ["patient_conversion"]);
    const l1 = await mkLead({ name: "Bulk T One", lead_value: "2500" });
    const l2 = await mkLead({ name: "Bulk T Two", lead_value: "abc" });
    const r = await api.post("/api/leads/bulk-convert", { lead_ids: [String(l1._id), String(l2._id)] });
    expect(r.body.convertedCount).toBe(2);
    const c1 = await LeadConversion.findOne({ lead: l1._id });
    const c2 = await LeadConversion.findOne({ lead: l2._id });
    expect(c1.treatment_name).toBe("Bulk Converted");
    expect(c1.treatment_amount).toBe(2500);
    expect(c2.treatment_amount).toBe(0);
  });
  test("[unit] no valid ids → 400", async () => {
    expect((await api.post("/api/leads/bulk-convert", { ids: ["x"] })).status).toBe(400);
  });
});

// ───────────────────────────── lost / junk / update ─────────────────────────────
describe("markAsLost / markAsJunk / updateLead", () => {
  test("[unit] lost sets lost and clears junk; junk sets junk and clears lost", async () => {
    const lead = await mkLead({ junk: true });
    let r = await api.patch(`/api/leads/${lead._id}/lost`);
    expect(r.status).toBe(200);
    let doc = await Lead.findById(lead._id);
    expect([doc.lost, doc.junk]).toEqual([true, false]);
    r = await api.patch(`/api/leads/${lead._id}/junk`);
    doc = await Lead.findById(lead._id);
    expect([doc.lost, doc.junk]).toEqual([false, true]);
  });
  test("[unit] changing followup_date resets followup_notified to false", async () => {
    const lead = await mkLead({ followup_date: new Date(), followup_notified: true });
    const r = await api.put(`/api/leads/${lead._id}`, { followup_date: new Date(Date.now() + 86400000).toISOString() });
    expect(r.status).toBe(200);
    expect((await Lead.findById(lead._id)).followup_notified).toBe(false);
  });
  test("[unit] update without followup_date keeps followup_notified", async () => {
    const lead = await mkLead({ followup_notified: true });
    await api.put(`/api/leads/${lead._id}`, { city: "Vadodara" });
    expect((await Lead.findById(lead._id)).followup_notified).toBe(true);
  });
  test("[unit] update with name '' → 400 validation error (not 500)", async () => {
    const lead = await mkLead();
    const r = await api.put(`/api/leads/${lead._id}`, { name: "" });
    expect(r.status).toBe(400);
  });
  test("[unit] update with name of only spaces → 400 (not 500)", async () => {
    const lead = await mkLead();
    const r = await api.put(`/api/leads/${lead._id}`, { name: "    " });
    expect(r.status).toBe(400);
  });
});

// ───────────────────────────── Meta webhook ─────────────────────────────
describe("webhook_controller", () => {
  afterEach(() => { graph.handler = null; delete process.env.META_WEBHOOK_VERIFY_TOKEN; });

  test("[unit] verifyWebhook echoes the challenge for the right token", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "unit-verify-token";
    const r = await call(webhookCtrl.verifyWebhook, { query: { "hub.mode": "subscribe", "hub.verify_token": "unit-verify-token", "hub.challenge": "777" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("777");
  });
  test("[unit] verifyWebhook → 403 on wrong token / wrong mode", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "unit-verify-token";
    expect((await call(webhookCtrl.verifyWebhook, { query: { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" } })).statusCode).toBe(403);
    expect((await call(webhookCtrl.verifyWebhook, { query: { "hub.mode": "unsubscribe", "hub.verify_token": "unit-verify-token" } })).statusCode).toBe(403);
  });
  test("[unit] receiveWebhook: non-page object → 404", async () => {
    expect((await call(webhookCtrl.receiveWebhook, { body: { object: "user", entry: [] } })).statusCode).toBe(404);
  });
  test("[unit] receiveWebhook: leadgen → one lead in the page's tenant via the page token; replay → no duplicate", async () => {
    const before = guard.graphCalls.length;
    const body = { object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "LG_UNIT_1", page_id: "PAGE_A_TEST" } }] }] };
    const r = await call(webhookCtrl.receiveWebhook, { body });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("EVENT_RECEIVED");
    const call1 = guard.graphCalls[before];
    expect(call1.url).toContain("/LG_UNIT_1");
    expect(call1.params.access_token).toBe("fake-page-token-A");
    const leads = await Lead.find({ meta_leadgen_id: "LG_UNIT_1" });
    expect(leads.length).toBe(1);
    expect(s(leads[0].tenant_id)).toBe(s(A.tenantId));
    expect(leads[0].name).toBe("Meta Fake Lead");
    expect(leads[0].meta_form_id).toBe("FORM_A1");
    expect(leads[0].meta_form_name).toBe("Fake Form");
    expect(s(leads[0].status)).toBe(s(A.statuses.New));
    await call(webhookCtrl.receiveWebhook, { body });
    expect(await Lead.countDocuments({ meta_leadgen_id: "LG_UNIT_1" })).toBe(1);
  });
  test("[unit] receiveWebhook: Graph error → still 200, no lead", async () => {
    graph.handler = () => ({ __status: 400, data: { error: { message: "Invalid token" } } });
    const body = { object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "LG_UNIT_ERR", page_id: "PAGE_A_TEST" } }] }] };
    const r = await call(webhookCtrl.receiveWebhook, { body });
    expect(r.statusCode).toBe(200);
    expect(await Lead.countDocuments({ meta_leadgen_id: "LG_UNIT_ERR" })).toBe(0);
  });
});

// ───────────────────────────── Website form receiveLead ─────────────────────────────
describe("website_lead_form_controller.receiveLead", () => {
  const pub = () => client(null);
  const post = (form, body) => pub().post(`/api/public/website-leads/${form.key}`, body);
  const latest = (form) => Lead.findOne({ tenant_id: form.tenant_id }).sort({ _id: -1 });

  test("[unit] no name → 'Website Lead'", async () => {
    const r = await post(A.websiteForm, { email: "anon@site.test" });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ success: true });
    expect((await latest(A.websiteForm)).name).toBe("Website Lead");
  });
  test.each([
    [{ full_name: "Alias Full" }, "Alias Full"],
    [{ fullname: "Alias Fullname" }, "Alias Fullname"],
    [{ name: "Primary Name", full_name: "Ignored" }, "Primary Name"],
  ])("[unit] name aliases %j → %s", async (body, expected) => {
    await post(A.websiteForm, body);
    expect((await latest(A.websiteForm)).name).toBe(expected);
  });
  test.each([["phone"], ["phone_number"], ["mobile"], ["phonenumber"]])("[unit] phone alias '%s'", async (key) => {
    await post(A.websiteForm, { name: `Phone ${key}`, [key]: "+91 90909 09090" });
    const l = await latest(A.websiteForm);
    expect(l.phonenumber).toBe("+91 90909 09090");
    expect(l.phone_last10).toBe("9090909090");
  });
  test("[unit] source auto-created with the form name once, then reused", async () => {
    expect(await LeadSource.countDocuments({ tenant_id: B.tenantId, name: B.websiteForm.name })).toBe(0);
    await post(B.websiteForm, { name: "B site 1" });
    await post(B.websiteForm, { name: "B site 2" });
    const srcs = await LeadSource.find({ tenant_id: B.tenantId, name: B.websiteForm.name });
    expect(srcs.length).toBe(1);
    const l = await latest(B.websiteForm);
    expect(s(l.source)).toBe(s(srcs[0]._id));
    expect(s(l.status)).toBe(s(B.statuses.New));
  });
  test("[unit] extra keys become 'leads_<key>' custom fields with the value stored", async () => {
    await post(A.websiteForm, { name: "Extra Keys", city: "Rajkot", "Type of space": "Office", timeline: " 3 months " });
    const l = await latest(A.websiteForm);
    expect(l.city).toBe("Rajkot");
    const f1 = await CustomField.findOne({ slug: "leads_type_of_space", tenant_id: A.tenantId });
    const f2 = await CustomField.findOne({ slug: "leads_timeline", tenant_id: A.tenantId });
    expect(f1.name).toBe("Type Of Space");
    expect(f1.fieldto).toBe("leads");
    expect(f2.name).toBe("Timeline");
    expect((await CustomFieldValue.findOne({ fieldid: f1._id, relid: l._id })).value).toBe("Office");
    expect((await CustomFieldValue.findOne({ fieldid: f2._id, relid: l._id })).value).toBe("3 months");
    expect(await CustomField.countDocuments({ slug: "leads_city" })).toBe(0);
  });
  test("[unit] unknown key → 404", async () => {
    expect((await pub().post("/api/public/website-leads/doesnotexist", { name: "x" })).status).toBe(404);
  });
});

describe("guard", () => {
  test("[unit] Graph calls were faked, real facebook.com never reached", () => {
    expect(guard.graphCalls.length).toBeGreaterThan(0);
    expect(guard.realFacebookCalls).toBe(0);
    console.log(`[leads.unit guard] graphCalls=${guard.graphCalls.length} realFacebookCalls=${guard.realFacebookCalls} blocked=${guard.blockedExternal.length}`);
  });
});
