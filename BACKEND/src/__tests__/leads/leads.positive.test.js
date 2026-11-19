// Leads module — POSITIVE API + DB tests (happy paths through the HTTP stack).
// In-memory MongoDB + faked Graph API / nodemailer only (see leadsStack.cjs).
// A failing test = a bug: each assertion states the CORRECT expected behaviour.
jest.setTimeout(120000);

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client, guard, getBaseUrl } = require("./leadsStack.cjs");

let A, api, pilot;
let Lead, LeadStatus, LeadSource, Client, Contact, LeadConversion, CustomField, CustomFieldValue, Reminder, Note, File, Task, MetaIntegration, WebsiteLeadForm;
const uploadedKeys = [];
const UPLOAD_DIR = path.join(__dirname, "../../uploads");

const s = (v) => (v == null ? v : String(v));
const tA = () => ({ tenant_id: A.tenantId });
const mkLead = (extra = {}) => Lead.create({ name: `P ${Math.random().toString(36).slice(2, 9)}`, tenant_id: A.tenantId, addedfrom: A.users.admin.id, ...extra });
const waitFor = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};

beforeAll(async () => {
  await start();
  ({ A } = await seedAll());
  Lead = require("../../models/Lead");
  LeadStatus = require("../../models/LeadStatus");
  LeadSource = require("../../models/LeadSource");
  Client = require("../../models/Client");
  Contact = require("../../models/Contact");
  LeadConversion = require("../../models/LeadConversion");
  CustomField = require("../../models/CustomField");
  CustomFieldValue = require("../../models/CustomFieldValue");
  Reminder = require("../../models/Reminder");
  Note = require("../../models/Note");
  File = require("../../models/File");
  Task = require("../../models/Task");
  MetaIntegration = require("../../models/MetaIntegration");
  WebsiteLeadForm = require("../../models/WebsiteLeadForm");
  await Promise.all([LeadConversion.init(), Client.init(), LeadStatus.init(), LeadSource.init()]);
  api = client(A.users.admin.token);
  pilot = client(A.users.pilot.token);
});
afterAll(async () => {
  for (const key of uploadedKeys) {
    const p = path.join(UPLOAD_DIR, key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  expect(guard.realFacebookCalls).toBe(0);
  await stop();
});

// ───────────────────────────── create / update ─────────────────────────────
describe("create & update", () => {
  test("[positive] create with only Status + Source + Name", async () => {
    const r = await api.post("/api/leads", { name: "Min Lead", status: String(A.statuses.New), source: String(A.sources.Website) });
    expect(r.status).toBe(201);
    const doc = await Lead.findById(r.body._id);
    expect(doc.name).toBe("Min Lead");
    expect(s(doc.status)).toBe(s(A.statuses.New));
    expect(s(doc.source)).toBe(s(A.sources.Website));
    expect(s(doc.tenant_id)).toBe(s(A.tenantId));
    expect(s(doc.addedfrom)).toBe(s(A.users.admin.id));
  });

  let fullId;
  const followup = new Date(Date.now() + 3 * 86400000).toISOString();
  const FULL = () => ({
    name: "Full Field Lead", title: "CTO", email: "  Full.Field@Example.COM ", website: "https://full.example.com",
    phonenumber: "+91 98989 89898", lead_value: "75000", company: "Full Co", address: "12 MG Road", city: "Ahmedabad",
    state: "Gujarat", country: "India", zip: "380001", default_language: "Gujarati", description: "Full description",
    followup_date: followup, is_public: true, contacted_today: true, tags: "vip,hot", assigned: String(A.users.full.id),
    status: String(A.statuses.Contacted), source: String(A.sources.Facebook), branch: "Navrangpura", salesPerson: "Ravi",
    custom_fields: { leads_budget_range: "5-10L" },
  });
  test("[positive] create with ALL fields (pilot user, branch + salesPerson) — response and DB", async () => {
    const r = await pilot.post("/api/leads", FULL());
    expect(r.status).toBe(201);
    fullId = r.body._id;
    const doc = (await Lead.findById(fullId)).toObject();
    const expected = {
      name: "Full Field Lead", title: "CTO", email: "full.field@example.com", website: "https://full.example.com",
      phonenumber: "+91 98989 89898", lead_value: "75000", company: "Full Co", address: "12 MG Road", city: "Ahmedabad",
      state: "Gujarat", country: "India", zip: "380001", default_language: "Gujarati", description: "Full description",
      is_public: true, contacted_today: true, tags: "vip,hot", branch: "Navrangpura", salesPerson: "Ravi", phone_last10: "9898989898",
    };
    for (const [k, v] of Object.entries(expected)) {
      expect(doc[k]).toBe(v);
      if (k !== "phone_last10") expect(r.body[k]).toBe(v);
    }
    expect(doc.followup_date.toISOString()).toBe(followup);
    expect(s(doc.assigned)).toBe(s(A.users.full.id));
    expect(s(doc.status)).toBe(s(A.statuses.Contacted));
    expect(s(doc.source)).toBe(s(A.sources.Facebook));
    expect(s(doc.addedfrom)).toBe(s(A.users.pilot.id));
    const one = await api.get(`/api/leads/${fullId}`);
    expect(one.status).toBe(200);
    expect(one.body.custom_fields.leads_budget_range).toBe("5-10L");
    expect(one.body.assigned.firstname).toBe("full");
  });
  test("[positive] update every field", async () => {
    const upd = {
      name: "Full Field Lead 2", title: "CEO", email: "NEW@Example.com", website: "https://new.example.com", phonenumber: "9123456789",
      lead_value: "90000", company: "New Co", address: "1 CG Road", city: "Surat", state: "GJ", country: "IN", zip: "395001",
      default_language: "Hindi", description: "Updated", followup_date: new Date(Date.now() + 5 * 86400000).toISOString(),
      is_public: false, contacted_today: false, tags: "cold", assigned: String(A.users.ownView.id), status: String(A.statuses.Confirmed),
      source: String(A.sources.WhatsApp), branch: "Satellite", salesPerson: "Meena", campaign: "Navratri",
      custom_fields: { leads_budget_range: "20L+" },
    };
    const r = await pilot.put(`/api/leads/${fullId}`, upd);
    expect(r.status).toBe(200);
    const doc = (await Lead.findById(fullId)).toObject();
    for (const k of ["name", "title", "website", "phonenumber", "lead_value", "company", "address", "city", "state", "country", "zip",
      "default_language", "description", "is_public", "contacted_today", "tags", "branch", "salesPerson", "campaign"]) {
      expect([k, doc[k]]).toEqual([k, upd[k]]);
    }
    expect(doc.email).toBe("new@example.com");
    expect(doc.phone_last10).toBe("9123456789");
    expect(doc.followup_date.toISOString()).toBe(upd.followup_date);
    expect(s(doc.assigned)).toBe(s(A.users.ownView.id));
    expect(s(doc.status)).toBe(s(A.statuses.Confirmed));
    expect(s(doc.source)).toBe(s(A.sources.WhatsApp));
  });
  test("[positive] update also saves custom field values", async () => {
    const one = await api.get(`/api/leads/${fullId}`);
    expect(one.body.custom_fields.leads_budget_range).toBe("20L+");
  });
  test("[positive] quick-add a status and a source", async () => {
    const st = await api.post("/api/lead-statuses", { name: "Hot Prospect", color: "#ff0000" });
    expect(st.status).toBe(201);
    expect(st.body.totalLeads).toBe(0);
    const src = await api.post("/api/lead-sources", { name: "Referral" });
    expect(src.status).toBe(201);
    expect(await LeadStatus.countDocuments({ ...tA(), name: "Hot Prospect", color: "#ff0000" })).toBe(1);
    expect(await LeadSource.countDocuments({ ...tA(), name: "Referral" })).toBe(1);
    const r = await api.post("/api/leads", { name: "Uses Quick Adds", status: st.body._id, source: src.body._id });
    expect(r.status).toBe(201);
    const list = await api.get("/api/lead-statuses");
    expect(list.body.find((x) => x.name === "Hot Prospect").totalLeads).toBe(1);
  });
});

// ───────────────────────────── notes / reminders / tasks / files ─────────────────────────────
describe("lead tabs: notes, reminders, tasks, files", () => {
  let lead;
  beforeAll(async () => { lead = await mkLead({ name: "Tab Lead" }); });

  test("[positive] notes: add contacted / not contacted, list, exists, delete", async () => {
    const n1 = await api.post("/api/notes", { rel_id: String(lead._id), rel_type: "lead", description: "Got in touch with this lead", type: "contacted" });
    expect(n1.status).toBe(201);
    expect(n1.body.type).toBe("contacted");
    expect(n1.body.addedfrom.firstname).toBe("admin");
    const n2 = await api.post("/api/notes", { rel_id: String(lead._id), rel_type: "lead", description: "Have not contacted this lead", type: "not_contacted" });
    expect(n2.status).toBe(201);
    const list = await api.get(`/api/notes?rel_id=${lead._id}&rel_type=lead`);
    expect(list.body.map((n) => n.type).sort()).toEqual(["contacted", "not_contacted"]);
    const ex = await api.get(`/api/notes/exists?rel_type=lead&rel_ids=${lead._id},${A.leads[0]}`);
    expect(ex.body).toEqual([s(lead._id)]);
    expect((await api.del(`/api/notes/${n2.body._id}`)).status).toBe(200);
    expect(await Note.countDocuments({ rel_id: lead._id })).toBe(1);
  });

  test("[positive] reminders: create / edit / complete / reopen / dismiss / delete, lead follow-up syncs", async () => {
    const { dayRange } = require("../../utils/appDate");
    const { start: dS, end: dE } = dayRange();
    const tomorrow = new Date(dE.getTime() + 3600000);
    const emailsBefore = guard.emails.length;
    const c = await api.post("/api/reminders", {
      description: "Call back", date: tomorrow.toISOString(), staff: String(A.users.full.id), rel_id: String(lead._id), rel_type: "lead", notify_by_email: true,
    });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe("pending");
    expect(c.body.notify_by_email).toBe(true);
    expect(s(c.body.staff)).toBe(s(A.users.full.id));
    const followIs = (d) => waitFor(async () => {
      const l = await Lead.findById(lead._id);
      return d === null ? l.followup_date == null : l.followup_date?.getTime() === d.getTime();
    });
    expect(await followIs(tomorrow)).toBe(true);
    const ids = async (b) => (await api.get(`/api/leads?reminder=${b}&limit=500`)).body.data.map((l) => s(l._id));
    expect(await ids("upcoming")).toContain(s(lead._id));

    const today = new Date((dS.getTime() + dE.getTime()) / 2);
    const e = await api.put(`/api/reminders/${c.body._id}`, { date: today.toISOString(), description: "Call back today" });
    expect(e.status).toBe(200);
    expect(e.body.description).toBe("Call back today");
    expect(await followIs(today)).toBe(true);
    expect(await ids("today")).toContain(s(lead._id));

    const done = await api.patch(`/api/reminders/${c.body._id}/complete`, { outcome_note: "spoke" });
    expect(done.body.status).toBe("completed");
    expect(done.body.outcome_note).toBe("spoke");
    expect(await followIs(null)).toBe(true);
    expect(await ids("none")).toContain(s(lead._id));

    const re = await api.patch(`/api/reminders/${c.body._id}/reopen`);
    expect(re.body.status).toBe("pending");
    expect(await followIs(today)).toBe(true);

    const dis = await api.patch(`/api/reminders/${c.body._id}/dismiss`);
    expect(dis.body.status).toBe("dismissed");
    expect(await followIs(null)).toBe(true);

    expect((await api.del(`/api/reminders/${c.body._id}`)).status).toBe(200);
    expect(await Reminder.countDocuments({ _id: c.body._id })).toBe(0);
    // Report only: "notify by email" is delivered by the reminder cron, not on save.
    console.log(`[leads.positive] emails sent on reminder create/edit: ${guard.emails.length - emailsBefore}`);
  });

  test("[positive] task on a lead (related_to = lead)", async () => {
    const r = await api.post("/api/tasks", { name: "Visit lead site", related_to: "lead", rel_id: String(lead._id), startdate: new Date().toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.rel_type).toBe("lead");
    expect(r.body.rel_type_model).toBe("Lead");
    const list = await api.get(`/api/tasks?rel_id=${lead._id}&rel_type=lead`);
    expect(list.body.map((t) => t.name)).toEqual(["Visit lead site"]);
    expect(s((await Task.findById(r.body._id)).tenant_id)).toBe(s(A.tenantId));
  });

  test("[positive] files: upload a .txt, list, delete (disk + DB)", async () => {
    const fd = new FormData();
    fd.append("rel_id", String(lead._id));
    fd.append("rel_type", "lead");
    fd.append("files", new Blob(["hello lead"], { type: "text/plain" }), "lead-note.txt");
    const res = await fetch(`${getBaseUrl()}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${A.users.admin.token}` }, body: fd });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.length).toBe(1);
    uploadedKeys.push(body[0].attachment_key);
    expect(body[0].file_name).toBe("lead-note.txt");
    expect(body[0].rel_type).toBe("lead");
    expect(fs.existsSync(path.join(UPLOAD_DIR, body[0].attachment_key))).toBe(true);
    const list = await api.get(`/api/files?rel_id=${lead._id}&rel_type=lead`);
    expect(list.body.length).toBe(1);
    expect((await api.del(`/api/files/${body[0]._id}`)).status).toBe(200);
    expect(await File.countDocuments({ _id: body[0]._id })).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, body[0].attachment_key))).toBe(false);
  });
});

// ───────────────────────────── status / lost / junk / delete ─────────────────────────────
describe("status, lost, junk, delete", () => {
  test("[positive] PATCH /:id/status moves the lead", async () => {
    const lead = await mkLead({ status: A.statuses.New });
    const r = await api.patch(`/api/leads/${lead._id}/status`, { status: String(A.statuses.Confirmed) });
    expect(r.status).toBe(200);
    expect(s((await Lead.findById(lead._id)).status)).toBe(s(A.statuses.Confirmed));
  });
  test("[positive] PATCH /:id/lost and /:id/junk", async () => {
    const lead = await mkLead();
    expect((await api.patch(`/api/leads/${lead._id}/lost`)).body.lead.lost).toBe(true);
    const j = await api.patch(`/api/leads/${lead._id}/junk`);
    expect(j.body.lead.junk).toBe(true);
    expect(j.body.lead.lost).toBe(false);
  });
  test("[positive] DELETE /:id removes the lead", async () => {
    const lead = await mkLead();
    const r = await api.del(`/api/leads/${lead._id}`);
    expect(r.status).toBe(200);
    expect(r.body.message).toBe("Lead removed");
    expect(await Lead.findById(lead._id)).toBeNull();
  });
  test("[positive] DELETE /:id also removes the lead's custom field values", async () => {
    const r0 = await api.post("/api/leads", { name: "Del CF Lead", custom_fields: { leads_budget_range: "1L" } });
    expect(await CustomFieldValue.countDocuments({ relid: r0.body._id })).toBe(1);
    await api.del(`/api/leads/${r0.body._id}`);
    expect(await CustomFieldValue.countDocuments({ relid: r0.body._id })).toBe(0);
  });
  test("[positive] a deleted lead's pending reminders are no longer counted on the overview", async () => {
    await setFeatures(A.tenantId, ["lead_followups"]);
    const { dayRange } = require("../../utils/appDate");
    const { start: dS, end: dE } = dayRange();
    const lead = await mkLead({ name: "Del Rem Lead" });
    const before = (await api.get("/api/leads/overview")).body.reminders.today;
    await api.post("/api/reminders", { description: "x", date: new Date((dS.getTime() + dE.getTime()) / 2).toISOString(), rel_id: String(lead._id), rel_type: "lead" });
    expect((await api.get("/api/leads/overview")).body.reminders.today).toBe(before + 1);
    await api.del(`/api/leads/${lead._id}`);
    expect((await api.get("/api/leads/overview")).body.reminders.today).toBe(before);
    await setFeatures(A.tenantId, []);
  });
});

// ───────────────────────────── convert + insights ─────────────────────────────
describe("convert & insights", () => {
  test("[positive] convert without patient_conversion → Client + primary Contact, converted, status Customer", async () => {
    const lead = await mkLead({ name: "Asha Patel", email: "asha@convert.test", phonenumber: "9876001234", company: "Asha Traders", city: "Rajkot", title: "Owner" });
    const r = await api.post(`/api/leads/${lead._id}/convert`, {});
    expect(r.status).toBe(201);
    expect(r.body.message).toBe("Lead converted to customer successfully");
    const doc = await Lead.findById(lead._id);
    expect(doc.converted).toBe(true);
    expect(s(doc.status)).toBe(s(A.statuses.Customer));
    const cl = await Client.findById(doc.client_id);
    expect(cl.company).toBe("Asha Traders");
    expect(cl.city).toBe("Rajkot");
    expect(cl.phoneE164).toBe("+919876001234");
    const ct = await Contact.findOne({ userid: cl._id });
    expect(ct.is_primary).toBe(true);
    expect([ct.firstname, ct.lastname, ct.email, ct.title]).toEqual(["Asha", "Patel", "asha@convert.test", "Owner"]);
    expect(await LeadConversion.countDocuments({ lead: lead._id })).toBe(0);
  });

  let conv;
  test("[positive] convert with patient_conversion → LeadConversion created from the treatment dialog", async () => {
    await setFeatures(A.tenantId, ["patient_conversion", "lead_followups"]);
    const lead = await mkLead({ name: "Treat Patient", source: A.sources.Facebook });
    const r = await api.post(`/api/leads/${lead._id}/convert`, { treatment_item: String(A.items[0]), treatment_amount: 5000, notes: "first visit" });
    expect(r.status).toBe(201);
    expect(r.body.message).toBe("Lead converted to patient successfully");
    conv = r.body.conversion;
    const db = await LeadConversion.findById(conv._id);
    expect(db.treatment_name).toBe("Root Canal A");
    expect(db.treatment_amount).toBe(5000);
    expect(db.notes).toBe("first visit");
    expect(db.source_name).toBe("Facebook");
    expect(s(db.converted_by)).toBe(s(A.users.admin.id));
    expect((await Lead.findById(lead._id)).converted).toBe(true);
  });
  test("[positive] GET /overview numbers match the DB", async () => {
    const r = await api.get("/api/leads/overview");
    expect(r.status).toBe(200);
    expect(r.body.leads.total).toBe(await Lead.countDocuments(tA()));
    expect(r.body.leads.converted).toBe(await Lead.countDocuments({ ...tA(), converted: true }));
    expect(r.body.leads.confirmed).toBe(await Lead.countDocuments({ ...tA(), status: A.statuses.Confirmed }));
    const sum = (await LeadConversion.find(tA())).reduce((a, c) => a + c.treatment_amount, 0);
    expect(r.body.treatment.total).toBe(sum);
    expect(r.body.features).toEqual(expect.arrayContaining(["patient_conversion", "lead_followups"]));
    expect(r.body.reminders).not.toBeNull();
  });
  test("[positive] GET /follow-ups (feature on) lists today's pending reminders with the lead", async () => {
    const { dayRange } = require("../../utils/appDate");
    const { start: dS, end: dE } = dayRange();
    const lead = await mkLead({ name: "FollowUp Lead" });
    await api.post("/api/reminders", { description: "fu", date: new Date((dS.getTime() + dE.getTime()) / 2).toISOString(), rel_id: String(lead._id), rel_type: "lead" });
    const r = await api.get("/api/leads/follow-ups?bucket=today");
    expect(r.status).toBe(200);
    const row = r.body.find((x) => s(x.rel_id) === s(lead._id));
    expect(row).toBeDefined();
    expect(row.lead.name).toBe("FollowUp Lead");
  });
  test("[positive] GET /conversions (feature on) and admin PUT /conversions/:id", async () => {
    const list = await api.get("/api/leads/conversions");
    expect(list.status).toBe(200);
    expect(list.body.data.some((c) => s(c._id) === s(conv._id))).toBe(true);
    expect(list.body.total).toBe(await LeadConversion.countDocuments(tA()));
    const u = await api.put(`/api/leads/conversions/${conv._id}`, { treatment_amount: 6000.555, treatment_name: "RCT Full", notes: "corrected" });
    expect(u.status).toBe(200);
    const db = await LeadConversion.findById(conv._id);
    expect([db.treatment_amount, db.treatment_name, db.notes]).toEqual([6000.56, "RCT Full", "corrected"]);
    await setFeatures(A.tenantId, []);
  });
});

// ───────────────────────────── list: counts, pages, filters, search ─────────────────────────────
describe("list", () => {
  test("[positive] statusCounts equal the DB counts per status", async () => {
    const r = await api.get("/api/leads?page=1");
    const agg = await Lead.aggregate([{ $match: tA() }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
    const want = Object.fromEntries(agg.map((x) => [s(x._id), x.count]));
    const got = Object.fromEntries(r.body.statusCounts.map((x) => [x.status, x.count]));
    expect(got).toEqual(want);
    expect(r.body.statusCounts.reduce((a, x) => a + x.count, 0)).toBe(await Lead.countDocuments(tA()));
  });
  test.each([10, 25, 50, 100])("[positive] page size %i", async (n) => {
    const total = await Lead.countDocuments(tA());
    const r = await api.get(`/api/leads?page=1&limit=${n}`);
    expect(r.body.data.length).toBe(Math.min(n, total));
    expect(r.body.pages).toBe(Math.max(Math.ceil(total / n), 1));
    expect(r.body.limit).toBe(n);
    if (total > n) {
      const p2 = await api.get(`/api/leads?page=2&limit=${n}`);
      const ids1 = new Set(r.body.data.map((l) => l._id));
      expect(p2.body.data.some((l) => ids1.has(l._id))).toBe(false);
    }
  });
  test("[positive] combined filters + search", async () => {
    const q = `/api/leads?limit=500&status=${A.statuses.New}&source=${A.sources.Website}&converted=no`;
    const r = await api.get(q);
    expect(r.body.total).toBe(await Lead.countDocuments({ ...tA(), status: A.statuses.New, source: A.sources.Website, converted: { $ne: true } }));
    const srch = await api.get("/api/leads?search=lead%20a1&limit=500");
    expect(srch.body.total).toBe(await Lead.countDocuments({ ...tA(), name: /lead a1/i }));
  });
});

// ───────────────────────────── import & bulk ─────────────────────────────
describe("import & bulk", () => {
  const rows = [
    { name: "Import One", email: "import.one@x.test", status: "New", source: "Website" },
    { name: "Import Two", phonenumber: "9811100002", status: "Contacted", source: "Facebook" },
    { name: "Import Three", company: "Three Co" },
  ];
  test("[positive] import 3 rows → success message", async () => {
    const r = await api.post("/api/leads/import", rows);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ count: 3, skipped: 0, message: "Imported 3 new lead(s)." });
    expect(await Lead.countDocuments({ ...tA(), name: { $in: rows.map((x) => x.name) } })).toBe(3);
  });
  test("[positive] same rows again → nothing imported, 'already exist' message", async () => {
    const r = await api.post("/api/leads/import", rows);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ count: 0, skipped: 3, message: "All 3 lead(s) already exist — nothing imported." });
    expect(await Lead.countDocuments({ ...tA(), name: { $in: rows.map((x) => x.name) } })).toBe(3);
  });
  test("[positive] bulk-delete", async () => {
    const [x, y] = await Promise.all([mkLead(), mkLead()]);
    const r = await api.post("/api/leads/bulk-delete", { ids: [String(x._id), String(y._id)] });
    expect(r.body.deletedCount).toBe(2);
    expect(await Lead.countDocuments({ _id: { $in: [x._id, y._id] } })).toBe(0);
  });
  test("[positive] bulk-convert counts", async () => {
    const [x, y] = await Promise.all([mkLead({ name: "BulkPos X" }), mkLead({ name: "BulkPos Y", email: "y@bulk.test" })]);
    const r = await api.post("/api/leads/bulk-convert", { ids: [String(x._id), String(y._id), String(A.leads[29])] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ convertedCount: 2, skippedCount: 1 });
    expect(r.body.message).toBe("Successfully converted 2 lead(s) to customer(s) (1 already converted).");
    expect(await Lead.countDocuments({ _id: { $in: [x._id, y._id] }, converted: true })).toBe(2);
    expect(await Contact.countDocuments({ email: "y@bulk.test" })).toBe(1);
  });
  test("[positive] bulk field update = PUT per lead (assigned, status, source, tags, is_public)", async () => {
    const leads = await Promise.all([mkLead(), mkLead(), mkLead()]);
    const patch = { assigned: String(A.users.full.id), status: String(A.statuses.Contacted), source: String(A.sources.WhatsApp), tags: "bulk", is_public: true };
    for (const l of leads) expect((await api.put(`/api/leads/${l._id}`, patch)).status).toBe(200);
    const docs = await Lead.find({ _id: { $in: leads.map((l) => l._id) } });
    for (const d of docs) {
      expect([s(d.assigned), s(d.status), s(d.source), d.tags, d.is_public]).toEqual([patch.assigned, patch.status, patch.source, "bulk", true]);
    }
  });
});

// ───────────────────────────── website form / Meta ─────────────────────────────
describe("lead capture: website form & Meta", () => {
  test("[positive] website form capture → lead in Tenant A, source = form name, default status, Budget custom field", async () => {
    const before = (await WebsiteLeadForm.findById(A.websiteForm._id)).total_leads;
    const r = await client(null).post(`/api/public/website-leads/${A.websiteForm.key}`, {
      name: "Web Visitor", email: "web.visitor@site.test", phone: "+91 97000 11122", city: "Bhavnagar", budget: "5 Lakh",
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ success: true });
    const lead = await Lead.findOne({ email: "web.visitor@site.test" }).populate("source");
    expect(s(lead.tenant_id)).toBe(s(A.tenantId));
    expect(lead.name).toBe("Web Visitor");
    expect(lead.phonenumber).toBe("+91 97000 11122");
    expect(lead.city).toBe("Bhavnagar");
    expect(lead.source.name).toBe("Site Contact Form A");
    expect(s(lead.status)).toBe(s(A.statuses.New));
    const f = await CustomField.findOne({ slug: "leads_budget", tenant_id: A.tenantId });
    expect(f.name).toBe("Budget");
    expect((await CustomFieldValue.findOne({ fieldid: f._id, relid: lead._id })).value).toBe("5 Lakh");
    expect((await WebsiteLeadForm.findById(A.websiteForm._id)).total_leads).toBe(before + 1);
    const one = await api.get(`/api/leads/${lead._id}`);
    expect(one.body.custom_fields.leads_budget).toBe("5 Lakh");
  });

  test("[positive] Meta webhook verify (GET) echoes the challenge", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "leads-positive-verify";
    const r = await client(null).get("/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=leads-positive-verify&hub.challenge=123");
    expect(r.status).toBe(200);
    expect(r.text).toBe("123");
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  });
  test("[positive] Meta webhook POST leadgen → one lead in Tenant A; replay → no duplicate", async () => {
    const graphBefore = guard.graphCalls.length;
    const body = { object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "LEADGEN_POS_1", page_id: "PAGE_A_TEST" } }] }] };
    const r = await client(null).post("/api/webhooks/meta-leads", body);
    expect(r.status).toBe(200);
    expect(r.text).toBe("EVENT_RECEIVED");
    const leads = await Lead.find({ meta_leadgen_id: "LEADGEN_POS_1" }).populate("source");
    expect(leads.length).toBe(1);
    const l = leads[0];
    expect(s(l.tenant_id)).toBe(s(A.tenantId));
    expect([l.name, l.email, l.phonenumber, l.phone_last10]).toEqual(["Meta Fake Lead", "meta.fake@lead.test", "+919812345678", "9812345678"]);
    expect(l.source.name).toBe("Fake Form");
    expect(l.meta_form_id).toBe("FORM_A1");
    expect(s(l.status)).toBe(s(A.statuses.New));
    expect(l.meta_field_data.get("city")).toBe("Ahmedabad");
    const cf = await CustomField.findOne({ slug: "meta_city", tenant_id: A.tenantId });
    expect((await CustomFieldValue.findOne({ fieldid: cf._id, relid: l._id })).value).toBe("Ahmedabad");
    expect(guard.graphCalls.length).toBe(graphBefore + 1);
    await client(null).post("/api/webhooks/meta-leads", body);
    expect(await Lead.countDocuments({ meta_leadgen_id: "LEADGEN_POS_1" })).toBe(1);
  });

  test("[positive] Meta integration: connect → sync → import-leads (twice) → disconnect", async () => {
    const graphBefore = guard.graphCalls.length;
    const c = await api.post("/api/meta-integration/connect", { page_id: "PAGE_POS_1", page_access_token: "user-token-123456" });
    expect(c.status).toBe(200);
    expect(c.body.page_name).toBe("Fake Page PAGE_POS_1");
    expect(c.body.page_access_token_masked).toBe("fake••••••••raph");
    expect(c.body.forms.map((f) => f.form_id)).toEqual(["FORM_A1"]);
    const db = await MetaIntegration.findOne({ page_id: "PAGE_POS_1" });
    expect(s(db.tenant_id)).toBe(s(A.tenantId));
    expect(db.page_access_token).toBe("fake-page-token-from-graph");

    const sy = await api.post("/api/meta-integration/PAGE_POS_1/sync");
    expect(sy.status).toBe(200);
    expect(sy.body.forms[0].questions.map((q) => q.key)).toContain("budget");

    const im = await api.post("/api/meta-integration/PAGE_POS_1/import-leads", {});
    expect(im.status).toBe(200);
    expect(im.body).toEqual({ imported: 2, skipped_duplicates: 0, truncated: false });
    expect(await Lead.countDocuments({ ...tA(), meta_leadgen_id: { $in: ["LEADGEN_IMPORT_1", "LEADGEN_IMPORT_2"] } })).toBe(2);
    const im2 = await api.post("/api/meta-integration/PAGE_POS_1/import-leads", { form_id: "FORM_A1" });
    expect(im2.body).toEqual({ imported: 0, skipped_duplicates: 2, truncated: false });

    const list = await api.get("/api/meta-integration");
    expect(list.body.connections.map((x) => x.page_id).sort()).toEqual(["PAGE_A_TEST", "PAGE_POS_1"]);

    const d = await api.del("/api/meta-integration/PAGE_POS_1");
    expect(d.status).toBe(200);
    expect(await MetaIntegration.countDocuments({ page_id: "PAGE_POS_1" })).toBe(0);
    expect(guard.graphCalls.length).toBeGreaterThan(graphBefore);
    expect(guard.graphCalls.slice(graphBefore).every((g) => /graph\.facebook\.com/.test(g.url))).toBe(true);
  });
});

describe("guard", () => {
  test("[positive] Graph faked, real facebook.com never reached", () => {
    expect(guard.graphCalls.length).toBeGreaterThan(0);
    expect(guard.realFacebookCalls).toBe(0);
    console.log(`[leads.positive guard] graphCalls=${guard.graphCalls.length} realFacebookCalls=${guard.realFacebookCalls} blocked=${guard.blockedExternal.length} emails=${guard.emails.length}`);
  });
});
