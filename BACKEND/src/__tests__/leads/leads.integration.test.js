// Leads module — INTEGRATION tests: permissions (view-only / no-access sweeps), own scope,
// tenant isolation A vs B (incl. a staff without tenant_id), and module links
// (convert -> Client/Contact/LeadConversion, deleted status/source/staff, reminders/notes/
// tasks/files by rel_id, statusCounts vs DB). In-memory MongoDB only, Graph API faked.
// Tests assert CORRECT behaviour — a failing test is a bug in the app, not in the test.
jest.setTimeout(180000);

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client, sign, guard } = require("./leadsStack.cjs");

let baseUrl, A, B;
let Lead, LeadStatus, LeadSource, Reminder, Note, FileM, MetaIntegration, WebsiteLeadForm, Client, Contact, LeadConversion, Task, Staff, Setting;
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
const uploadedKeys = [];
const observations = []; // facts worth reporting that are not pass/fail
let seq = 0;
const uid = (p = "T") => `${p}-${Date.now().toString(36)}-${++seq}`;
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const blocked = (s) => s === 403 || s === 404;

// ---------- fixtures (created straight in the DB so no app side effects run) ----------
const mkLead = async (T, extra = {}) =>
  (await Lead.create({
    name: uid(`Tmp ${T.label}`), tenant_id: T.tenantId, status: T.statuses.New, source: T.sources.Website,
    addedfrom: T.users.admin.id, ...extra,
  }))._id;
const mkReminder = async (T, relId, extra = {}) =>
  (await Reminder.create({
    description: uid("rem"), date: new Date(Date.now() + 86400000 * 3), rel_id: relId, rel_type: "lead",
    staff: T.users.admin.id, creator: T.users.admin.id, tenant_id: T.tenantId, status: "pending", ...extra,
  }))._id;
const mkNote = async (T, relId) =>
  (await Note.create({ rel_id: relId, rel_type: "lead", description: uid("note"), addedfrom: T.users.admin.id, tenant_id: T.tenantId }))._id;
const mkFile = async (T, relId) =>
  (await FileM.create({ rel_id: relId, rel_type: "lead", file_name: "x.txt", attachment_key: `no-such-file-${uid()}.txt`, addedfrom: T.users.admin.id, tenant_id: T.tenantId }))._id;
const mkStatus = async (T) => (await LeadStatus.create({ name: uid("St"), statusorder: 50, tenant_id: T.tenantId }))._id;
const mkSource = async (T) => (await LeadSource.create({ name: uid("Src"), tenant_id: T.tenantId }))._id;
const mkConversion = async (T) => {
  const lead = await mkLead(T, { converted: true });
  return (await LeadConversion.create({ tenant_id: T.tenantId, lead, client: new mongoose.Types.ObjectId(), treatment_name: "Fixture", treatment_amount: 100 }))._id;
};
const mkPage = async (T) => {
  const page_id = uid("PAGE_SWEEP");
  await MetaIntegration.create({
    tenant_id: T.tenantId, page_id, page_name: "Sweep Page", page_access_token: "fake-sweep-token",
    forms: [{ form_id: uid("FORM_SWEEP"), name: "Sweep Form", status: "ACTIVE", questions: [] }], connected_by: T.users.admin.id,
  });
  return page_id;
};
const mkForm = async (T) => (await WebsiteLeadForm.create({ tenant_id: T.tenantId, name: uid("Form"), created_by: T.users.admin.id }))._id;

const uploadFile = async (token, relId, relType = "lead") => {
  const fd = new FormData();
  fd.append("files", new Blob(["hello"], { type: "text/plain" }), `${uid("up")}.txt`);
  fd.append("rel_id", String(relId));
  fd.append("rel_type", relType);
  const res = await fetch(`${baseUrl}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = await res.json().catch(() => null);
  if (Array.isArray(body)) body.forEach((f) => f.attachment_key && uploadedKeys.push(f.attachment_key));
  return { status: res.status, body };
};

// ---------- DB fingerprint: which collections a call changed ----------
const watched = () => ({ Lead, LeadStatus, LeadSource, Reminder, Note, File: FileM, MetaIntegration, WebsiteLeadForm, Client, Contact, LeadConversion, Task });
const snapshot = async () => {
  const out = {};
  for (const [k, M] of Object.entries(watched())) {
    const docs = await M.find({}).sort({ _id: 1 }).lean();
    out[k] = `${crypto.createHash("sha1").update(JSON.stringify(docs)).digest("hex")}:${docs.length}`;
  }
  return out;
};
const diff = (a, b) =>
  Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}(${a[k].split(":")[1]}->${b[k].split(":")[1]})`).join(",") || "none";

/** Runs a call between two fingerprints, returns "<label> -> <status> db:<changes>[ msg]". */
const probe = async (label, fn, expectStatus = 403) => {
  await settle(60);
  const before = await snapshot();
  const r = await fn();
  await settle();
  const after = await snapshot();
  const msg = r.status !== expectStatus && r.body?.message ? ` msg:${String(r.body.message).slice(0, 70)}` : "";
  return { r, line: `${label} -> ${r.status} db:${diff(before, after)}${msg}` };
};

// Every write route of the Leads module (and its satellites). [label, setup(T) -> ctx, call(c, ctx, token)]
const WRITE_ROUTES = [
  ["POST /api/leads", async () => ({}), (c) => c.post("/api/leads", { name: uid("Sweep create") })],
  ["POST /api/leads/import", async () => ({}), (c) => c.post("/api/leads/import", [{ name: uid("Sweep import") }])],
  ["POST /api/leads/bulk-delete", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.post("/api/leads/bulk-delete", { ids: [x.lead] })],
  ["POST /api/leads/bulk-convert", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.post("/api/leads/bulk-convert", { ids: [x.lead] })],
  ["POST /api/leads/:id/convert", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.post(`/api/leads/${x.lead}/convert`, { treatment_name: "Sweep", treatment_amount: 10 })],
  ["PATCH /api/leads/:id/lost", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.patch(`/api/leads/${x.lead}/lost`, {})],
  ["PATCH /api/leads/:id/junk", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.patch(`/api/leads/${x.lead}/junk`, {})],
  ["PATCH /api/leads/:id/status", async (T) => ({ lead: await mkLead(T), st: T.statuses.Contacted }), (c, x) => c.patch(`/api/leads/${x.lead}/status`, { status: String(x.st) })],
  ["PUT /api/leads/:id", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.put(`/api/leads/${x.lead}`, { city: "changed by sweep" })],
  ["DELETE /api/leads/:id", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.del(`/api/leads/${x.lead}`)],
  ["PUT /api/leads/conversions/:id", async (T) => ({ conv: await mkConversion(T) }), (c, x) => c.put(`/api/leads/conversions/${x.conv}`, { treatment_amount: 999 })],
  ["POST /api/leads/pipeline-statuses", async () => ({}), (c) => c.post("/api/leads/pipeline-statuses", {})],
  ["POST /api/lead-statuses", async () => ({}), (c) => c.post("/api/lead-statuses", { name: uid("SweepSt") })],
  ["POST /api/lead-statuses/bulk", async () => ({}), (c) => c.post("/api/lead-statuses/bulk", { items: [uid("SweepStB")] })],
  ["PATCH /api/lead-statuses/:id", async (T) => ({ st: await mkStatus(T) }), (c, x) => c.patch(`/api/lead-statuses/${x.st}`, { color: "#000000" })],
  ["DELETE /api/lead-statuses/:id", async (T) => ({ st: await mkStatus(T) }), (c, x) => c.del(`/api/lead-statuses/${x.st}`)],
  ["POST /api/lead-sources", async () => ({}), (c) => c.post("/api/lead-sources", { name: uid("SweepSrc") })],
  ["POST /api/lead-sources/bulk", async () => ({}), (c) => c.post("/api/lead-sources/bulk", { items: [uid("SweepSrcB")] })],
  ["PATCH /api/lead-sources/:id", async (T) => ({ src: await mkSource(T) }), (c, x) => c.patch(`/api/lead-sources/${x.src}`, { name: uid("Renamed") })],
  ["DELETE /api/lead-sources/:id", async (T) => ({ src: await mkSource(T) }), (c, x) => c.del(`/api/lead-sources/${x.src}`)],
  ["POST /api/lead-pipeline/statuses", async (T) => ({ t: T.tenantId }), (c, x) => c.post("/api/lead-pipeline/statuses", { name: uid("PipeSt"), tenant_id: String(x.t) })],
  ["POST /api/lead-pipeline/sources", async (T) => ({ t: T.tenantId }), (c, x) => c.post("/api/lead-pipeline/sources", { name: uid("PipeSrc"), tenant_id: String(x.t) })],
  ["POST /api/reminders (lead)", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.post("/api/reminders", { description: "sweep", date: new Date(Date.now() + 86400000).toISOString(), rel_id: String(x.lead), rel_type: "lead" })],
  ["PUT /api/reminders/:id", async (T) => ({ rem: await mkReminder(T, await mkLead(T)) }), (c, x) => c.put(`/api/reminders/${x.rem}`, { description: "edited by sweep" })],
  ["PATCH /api/reminders/:id", async (T) => ({ rem: await mkReminder(T, await mkLead(T)) }), (c, x) => c.patch(`/api/reminders/${x.rem}`, { description: "patched by sweep" })],
  ["PATCH /api/reminders/:id/complete", async (T) => ({ rem: await mkReminder(T, await mkLead(T)) }), (c, x) => c.patch(`/api/reminders/${x.rem}/complete`, {})],
  ["PATCH /api/reminders/:id/dismiss", async (T) => ({ rem: await mkReminder(T, await mkLead(T)) }), (c, x) => c.patch(`/api/reminders/${x.rem}/dismiss`, {})],
  ["PATCH /api/reminders/:id/reopen", async (T) => ({ rem: await mkReminder(T, await mkLead(T), { status: "completed" }) }), (c, x) => c.patch(`/api/reminders/${x.rem}/reopen`, {})],
  ["DELETE /api/reminders/:id", async (T) => ({ rem: await mkReminder(T, await mkLead(T)) }), (c, x) => c.del(`/api/reminders/${x.rem}`)],
  ["POST /api/notes (lead)", async (T) => ({ lead: await mkLead(T) }), (c, x) => c.post("/api/notes", { rel_id: String(x.lead), rel_type: "lead", description: "sweep note" })],
  ["PUT /api/notes/:id", async (T) => ({ note: await mkNote(T, await mkLead(T)) }), (c, x) => c.put(`/api/notes/${x.note}`, { description: "edited by sweep" })],
  ["DELETE /api/notes/:id", async (T) => ({ note: await mkNote(T, await mkLead(T)) }), (c, x) => c.del(`/api/notes/${x.note}`)],
  ["POST /api/files (lead)", async (T) => ({ lead: await mkLead(T) }), (c, x, token) => uploadFile(token, x.lead)],
  ["DELETE /api/files/:fileId", async (T) => ({ file: await mkFile(T, await mkLead(T)) }), (c, x) => c.del(`/api/files/${x.file}`)],
  ["POST /api/meta-integration/connect", async () => ({ page: uid("PAGE_NEW") }), (c, x) => c.post("/api/meta-integration/connect", { page_id: x.page, page_access_token: "fake-user-token" })],
  ["POST /api/meta-integration/:pageId/sync", async (T) => ({ page: await mkPage(T) }), (c, x) => c.post(`/api/meta-integration/${x.page}/sync`, {})],
  ["POST /api/meta-integration/:pageId/import-leads", async (T) => ({ page: await mkPage(T) }), (c, x) => c.post(`/api/meta-integration/${x.page}/import-leads`, {})],
  ["DELETE /api/meta-integration/:pageId", async (T) => ({ page: await mkPage(T) }), (c, x) => c.del(`/api/meta-integration/${x.page}`)],
  ["POST /api/website-lead-forms", async () => ({}), (c) => c.post("/api/website-lead-forms", { name: uid("Sweep form") })],
  ["DELETE /api/website-lead-forms/:id", async (T) => ({ form: await mkForm(T) }), (c, x) => c.del(`/api/website-lead-forms/${x.form}`)],
];

// Reads a user with NO Leads permission must not reach.
const READ_ROUTES = [
  ["GET /api/leads", async () => ({}), (c) => c.get("/api/leads")],
  ["GET /api/leads?page=1", async () => ({}), (c) => c.get("/api/leads?page=1&limit=10")],
  ["GET /api/leads/overview", async () => ({}), (c) => c.get("/api/leads/overview")],
  ["GET /api/leads/follow-ups", async () => ({}), (c) => c.get("/api/leads/follow-ups?bucket=upcoming")],
  ["GET /api/leads/conversions", async () => ({}), (c) => c.get("/api/leads/conversions")],
  ["GET /api/leads/:id", async (T) => ({ lead: T.leads[3] }), (c, x) => c.get(`/api/leads/${x.lead}`)],
  ["GET /api/lead-statuses", async () => ({}), (c) => c.get("/api/lead-statuses")],
  ["GET /api/lead-sources", async () => ({}), (c) => c.get("/api/lead-sources")],
  ["GET /api/lead-pipeline/statuses", async () => ({}), (c) => c.get("/api/lead-pipeline/statuses")],
  ["GET /api/lead-pipeline/sources", async () => ({}), (c) => c.get("/api/lead-pipeline/sources")],
  ["GET /api/reminders?rel_id=<lead>", async (T) => { const lead = await mkLead(T); await mkReminder(T, lead); return { lead }; }, (c, x) => c.get(`/api/reminders?rel_type=lead&rel_id=${x.lead}`)],
  ["GET /api/notes?rel_id=<lead>", async (T) => { const lead = await mkLead(T); await mkNote(T, lead); return { lead }; }, (c, x) => c.get(`/api/notes?rel_type=lead&rel_id=${x.lead}`)],
  ["GET /api/notes/exists", async (T) => { const lead = await mkLead(T); await mkNote(T, lead); return { lead }; }, (c, x) => c.get(`/api/notes/exists?rel_type=lead&rel_ids=${x.lead}`)],
  ["GET /api/files?rel_id=<lead>", async (T) => { const lead = await mkLead(T); await mkFile(T, lead); return { lead }; }, (c, x) => c.get(`/api/files?rel_type=lead&rel_id=${x.lead}`)],
  ["GET /api/meta-integration", async () => ({}), (c) => c.get("/api/meta-integration")],
  ["GET /api/website-lead-forms", async () => ({}), (c) => c.get("/api/website-lead-forms")],
];

// Own-scope set straight from the DB (leadScope.js rule).
const ownScopeQuery = (T, userId) => ({ tenant_id: T.tenantId, $or: [{ assigned: userId }, { addedfrom: userId }, { is_public: true }] });
const dbStatusCounts = async (match) => {
  const rows = await Lead.aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
};
const apiStatusCounts = (body) => Object.fromEntries((body.statusCounts || []).map((s) => [String(s.status), s.count]));

let ownFull; // View (Own) + Create + Edit + Delete — created in beforeAll

beforeAll(async () => {
  ({ baseUrl } = await start());
  ({ A, B } = await seedAll());
  Lead = require("../../models/Lead");
  LeadStatus = require("../../models/LeadStatus");
  LeadSource = require("../../models/LeadSource");
  Reminder = require("../../models/Reminder");
  Note = require("../../models/Note");
  FileM = require("../../models/File");
  MetaIntegration = require("../../models/MetaIntegration");
  WebsiteLeadForm = require("../../models/WebsiteLeadForm");
  Client = require("../../models/Client");
  Contact = require("../../models/Contact");
  LeadConversion = require("../../models/LeadConversion");
  Task = require("../../models/Task");
  Staff = require("../../models/Staff");
  Setting = require("../../models/Setting");
  // Feature gates on, so the permission layer — not the add-on gate — decides.
  await setFeatures(A.tenantId, ["lead_followups", "patient_conversion"]);
  await setFeatures(B.tenantId, ["lead_followups", "patient_conversion"]);
  const id = new mongoose.Types.ObjectId();
  await Staff.create({
    _id: id, firstname: "ownFull", lastname: "A", email: "ownfull.a@leads-test.local", password: "password123", active: true,
    tenant_id: A.tenantId, admin: false, permissions: { Leads: { "View (Own)": true, Create: true, Edit: true, Delete: true } },
  });
  ownFull = { id, token: sign(id) };
});

afterAll(async () => {
  for (const k of uploadedKeys) { try { fs.unlinkSync(path.join(UPLOAD_DIR, k)); } catch { /* already gone */ } }
  if (observations.length) console.log(`[leads.integration observations]\n- ${observations.join("\n- ")}`);
  expect(guard.realFacebookCalls).toBe(0);
  await stop();
});

// ================================================================= 1. PERMISSIONS
describe("1. Permissions — checkPermission really enforces a non-View action", () => {
  test("[perm] Edit-gated /api/meta-integration: viewOnly 403, full 200", async () => {
    expect((await client(A.users.viewOnly.token).get("/api/meta-integration")).status).toBe(403);
    expect((await client(A.users.full.token).get("/api/meta-integration")).status).toBe(200);
  });
  test("[perm] Edit-gated /api/website-lead-forms: viewOnly 403, full 200", async () => {
    expect((await client(A.users.viewOnly.token).get("/api/website-lead-forms")).status).toBe(403);
    expect((await client(A.users.full.token).get("/api/website-lead-forms")).status).toBe(200);
  });
  test("[perm] lowercase 'create' on /api/lead-pipeline: viewOnly 403, full (Create) passes", async () => {
    const name = uid("PipeFull");
    expect((await client(A.users.viewOnly.token).post("/api/lead-pipeline/statuses", { name, tenant_id: String(A.tenantId) })).status).toBe(403);
    const r = await client(A.users.full.token).post("/api/lead-pipeline/statuses", { name, tenant_id: String(A.tenantId) });
    expect(r.status).toBe(201);
    await LeadStatus.deleteOne({ _id: r.body._id });
  });
  test("[perm] import with 'allow non-admin import' ON: viewOnly (no Create) must still get 403", async () => {
    await Setting.create({ name: "leadAllowNonAdminImport", value: "1", tenant_id: A.tenantId });
    try {
      const name = uid("ViewOnly import");
      const { line } = await probe("POST /api/leads/import (setting on)", () => client(A.users.viewOnly.token).post("/api/leads/import", [{ name }]));
      expect(line).toBe("POST /api/leads/import (setting on) -> 403 db:none");
    } finally {
      await Setting.deleteOne({ name: "leadAllowNonAdminImport", tenant_id: A.tenantId });
      await Lead.deleteMany({ name: /^ViewOnly import/ });
    }
  });
  test("[perm] full (Create) user can create a lead; viewOnly can read it", async () => {
    const r = await client(A.users.full.token).post("/api/leads", { name: uid("Full created") });
    expect(r.status).toBe(201);
    expect((await client(A.users.viewOnly.token).get(`/api/leads/${r.body._id}`)).status).toBe(200);
    await Lead.deleteOne({ _id: r.body._id });
  });
  test("[perm] inactive staff -> 401 on every Leads route", async () => {
    const c = client(A.users.inactive.token);
    expect((await c.get("/api/leads")).status).toBe(401);
    expect((await c.post("/api/leads", { name: "x" })).status).toBe(401);
    expect((await c.get("/api/reminders")).status).toBe(401);
  });
});

describe("2a. VIEW-ONLY write sweep — every write must be 403 with no DB change", () => {
  test("[perm][viewOnly] can read the list", async () => {
    expect((await client(A.users.viewOnly.token).get("/api/leads")).status).toBe(200);
  });
  test.each(WRITE_ROUTES)("[perm][viewOnly] %s -> 403", async (label, setup, call) => {
    const ctx = await setup(A);
    const u = A.users.viewOnly;
    const { line } = await probe(label, () => call(client(u.token), ctx, u.token));
    expect(line).toBe(`${label} -> 403 db:none`);
  });
});

describe("2b. NO-ACCESS sweep — every read AND write must be 403 with no DB change", () => {
  test.each(READ_ROUTES)("[perm][noAccess] %s -> 403", async (label, setup, call) => {
    const ctx = await setup(A);
    const u = A.users.noAccess;
    const { r, line } = await probe(label, () => call(client(u.token), ctx, u.token));
    const leaked = Array.isArray(r.body) ? ` rows:${r.body.length}` : "";
    expect(`${line}${r.status === 403 ? "" : leaked}`).toBe(`${label} -> 403 db:none`);
  });
  test.each(WRITE_ROUTES)("[perm][noAccess] %s -> 403", async (label, setup, call) => {
    const ctx = await setup(A);
    const u = A.users.noAccess;
    const { line } = await probe(label, () => call(client(u.token), ctx, u.token));
    expect(line).toBe(`${label} -> 403 db:none`);
  });
  test("[perm][noAccess] can read a lead's reminder/note TEXT by id (data exposure)", async () => {
    const lead = await mkLead(A);
    await Reminder.create({ description: "SECRET-REMINDER", date: new Date(), rel_id: lead, rel_type: "lead", staff: A.users.admin.id, creator: A.users.admin.id, tenant_id: A.tenantId });
    await Note.create({ rel_id: lead, rel_type: "lead", description: "SECRET-NOTE", addedfrom: A.users.admin.id, tenant_id: A.tenantId });
    const c = client(A.users.noAccess.token);
    const rem = await c.get(`/api/reminders?rel_type=lead&rel_id=${lead}`);
    const notes = await c.get(`/api/notes?rel_type=lead&rel_id=${lead}`);
    const seen = [rem, notes].filter((r) => r.status === 200 && JSON.stringify(r.body).includes("SECRET-")).length;
    expect(`noAccess saw ${seen} secret record(s)`).toBe("noAccess saw 0 secret record(s)");
  });
});

// ================================================================= 3. OWN SCOPE
describe("3. Own scope (assigned = me OR addedfrom = me OR is_public)", () => {
  test("[scope] ownView GET /api/leads returns exactly the own-scope set", async () => {
    const r = await client(A.users.ownView.token).get("/api/leads");
    expect(r.status).toBe(200);
    const expected = (await Lead.find(ownScopeQuery(A, A.users.ownView.id)).distinct("_id")).map(String).sort();
    expect(r.body.map((l) => String(l._id)).sort()).toEqual(expected);
  });
  test("[scope] ownView paginated total + statusCounts == DB counts of own scope", async () => {
    const r = await client(A.users.ownView.token).get("/api/leads?page=1&limit=500");
    expect(r.status).toBe(200);
    const q = ownScopeQuery(A, A.users.ownView.id);
    expect(r.body.total).toBe(await Lead.countDocuments(q));
    expect(apiStatusCounts(r.body)).toEqual(await dbStatusCounts(q));
  });
  test("[scope] ownView GET /:id — out-of-scope 404, someone else's public lead 200", async () => {
    const c = client(A.users.ownView.token);
    const privateOther = await mkLead(A, { assigned: A.users.full.id, is_public: false });
    const publicOther = await mkLead(A, { assigned: A.users.full.id, is_public: true });
    expect((await c.get(`/api/leads/${privateOther}`)).status).toBe(404);
    expect((await c.get(`/api/leads/${publicOther}`)).status).toBe(200);
  });
  test.each([
    ["PUT /:id", (c, id) => c.put(`/api/leads/${id}`, { city: "edited by ownView" })],
    ["PATCH /:id/status", (c, id, T) => c.patch(`/api/leads/${id}/status`, { status: String(T.statuses.Confirmed) })],
    ["PATCH /:id/lost", (c, id) => c.patch(`/api/leads/${id}/lost`, {})],
    ["DELETE /:id", (c, id) => c.del(`/api/leads/${id}`)],
  ])("[scope] ownView (View (Own) only, no Edit/Delete) %s on another staff's PUBLIC lead -> blocked", async (label, call) => {
    const id = await mkLead(A, { assigned: A.users.full.id, is_public: true });
    const { r, line } = await probe(label, () => call(client(A.users.ownView.token), id, A));
    expect(blocked(r.status) && line.includes("db:none") ? `${label} -> blocked` : line).toBe(`${label} -> blocked`);
  });
  test.each([
    ["PUT /:id", (c, id) => c.put(`/api/leads/${id}`, { city: "edited by ownFull" })],
    ["DELETE /:id", (c, id) => c.del(`/api/leads/${id}`)],
    ["POST /:id/convert", (c, id) => c.post(`/api/leads/${id}/convert`, { treatment_name: "x", treatment_amount: 1 })],
  ])("[scope] own-scope user WITH Edit/Delete %s on another staff's PUBLIC lead -> blocked (public = visible, not editable)", async (label, call) => {
    const id = await mkLead(A, { assigned: A.users.full.id, addedfrom: A.users.admin.id, is_public: true });
    const { r, line } = await probe(label, () => call(client(ownFull.token), id));
    expect(blocked(r.status) && line.includes("db:none") ? `${label} -> blocked` : line).toBe(`${label} -> blocked`);
  });
  test("[scope] ownFull can edit its own assigned lead (positive control)", async () => {
    const id = await mkLead(A, { assigned: ownFull.id });
    const r = await client(ownFull.token).put(`/api/leads/${id}`, { city: "Mine" });
    expect(r.status).toBe(200);
    expect((await Lead.findById(id)).city).toBe("Mine");
  });
  test("[scope] ownFull bulk-delete [own, out-of-scope private] -> only own deleted", async () => {
    const mine = await mkLead(A, { assigned: ownFull.id });
    const other = await mkLead(A, { assigned: A.users.full.id, is_public: false });
    const r = await client(ownFull.token).post("/api/leads/bulk-delete", { ids: [mine, other] });
    expect(r.status).toBe(200);
    expect(r.body.deletedCount).toBe(1);
    expect(await Lead.exists({ _id: mine })).toBeNull();
    expect(await Lead.exists({ _id: other })).not.toBeNull();
  });
  test("[scope] ownFull bulk-convert [own, out-of-scope private] -> only own converted", async () => {
    const mine = await mkLead(A, { assigned: ownFull.id });
    const other = await mkLead(A, { assigned: A.users.full.id, is_public: false });
    const r = await client(ownFull.token).post("/api/leads/bulk-convert", { ids: [mine, other] });
    expect(r.status).toBe(200);
    expect(r.body.convertedCount).toBe(1);
    expect((await Lead.findById(mine)).converted).toBe(true);
    expect((await Lead.findById(other)).converted).toBe(false);
  });
  test("[scope] ownView overview leads.total/converted == own-scope DB counts", async () => {
    const r = await client(A.users.ownView.token).get("/api/leads/overview");
    expect(r.status).toBe(200);
    const q = ownScopeQuery(A, A.users.ownView.id);
    expect(r.body.leads.total).toBe(await Lead.countDocuments(q));
    expect(r.body.leads.converted).toBe(await Lead.countDocuments({ ...q, converted: true }));
  });
  test("[scope] ownView follow-ups only list reminders of in-scope leads", async () => {
    const mine = await mkLead(A, { assigned: A.users.ownView.id });
    const other = await mkLead(A, { assigned: A.users.full.id, is_public: false });
    const later = new Date(Date.now() + 86400000 * 5);
    const rMine = await mkReminder(A, mine, { date: later });
    const rOther = await mkReminder(A, other, { date: later });
    const r = await client(A.users.ownView.token).get("/api/leads/follow-ups?bucket=upcoming&limit=200");
    expect(r.status).toBe(200);
    const ids = r.body.map((x) => String(x._id));
    expect(ids).toContain(String(rMine));
    expect(ids).not.toContain(String(rOther));
  });
  test("[scope] ownView conversions only for in-scope leads", async () => {
    const other = await mkLead(A, { assigned: A.users.full.id, is_public: false, converted: true });
    const conv = await LeadConversion.create({ tenant_id: A.tenantId, lead: other, treatment_name: "Hidden", treatment_amount: 5 });
    const r = await client(A.users.ownView.token).get("/api/leads/conversions?limit=200");
    expect(r.status).toBe(200);
    expect(r.body.data.map((c) => String(c._id))).not.toContain(String(conv._id));
  });
  test.each(["admin", "viewOnly", "full"])("[scope] %s: paginated total + statusCounts == tenant DB counts", async (who) => {
    const r = await client(A.users[who].token).get("/api/leads?page=1&limit=5");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(await Lead.countDocuments({ tenant_id: A.tenantId }));
    expect(apiStatusCounts(r.body)).toEqual(await dbStatusCounts({ tenant_id: A.tenantId }));
  });
});

// ================================================================= 4. TENANT ISOLATION
describe("4. Tenant isolation — A never reads/writes B", () => {
  const bLead = () => B.leads[4];
  test.each([
    ["GET /:id", (c, id) => c.get(`/api/leads/${id}`)],
    ["PUT /:id", (c, id) => c.put(`/api/leads/${id}`, { city: "hacked by A" })],
    ["DELETE /:id", (c, id) => c.del(`/api/leads/${id}`)],
    ["PATCH /:id/status", (c, id) => c.patch(`/api/leads/${id}/status`, { status: String(A.statuses.Contacted) })],
    ["PATCH /:id/lost", (c, id) => c.patch(`/api/leads/${id}/lost`, {})],
    ["PATCH /:id/junk", (c, id) => c.patch(`/api/leads/${id}/junk`, {})],
    ["POST /:id/convert", (c, id) => c.post(`/api/leads/${id}/convert`, { treatment_name: "x", treatment_amount: 1 })],
    ["POST /api/reminders on B lead", (c, id) => c.post("/api/reminders", { description: "x", date: new Date().toISOString(), rel_id: String(id), rel_type: "lead" })],
    ["POST /api/notes on B lead", (c, id) => c.post("/api/notes", { rel_id: String(id), rel_type: "lead", description: "A note on B lead" })],
    ["POST /api/files on B lead", (c, id) => uploadFile(A.users.admin.token, id)],
    ["POST /api/tasks on B lead", (c, id) => c.post("/api/tasks", { name: uid("A task on B lead"), related_to: "lead", rel_id: String(id) })],
  ])("[tenant] A admin %s with a B lead id -> 404, nothing written", async (label, call) => {
    const id = await mkLead(B);
    const { r, line } = await probe(label, () => call(client(A.users.admin.token), id));
    expect(blocked(r.status) && line.includes("db:none") ? `${label} -> blocked` : line).toBe(`${label} -> blocked`);
  });
  test("[tenant] A cannot read / edit / complete / delete B's reminder, note, file, conversion", async () => {
    const lead = bLead();
    const rem = await mkReminder(B, lead);
    const note = await mkNote(B, lead);
    const file = await mkFile(B, lead);
    const conv = await mkConversion(B);
    const c = client(A.users.admin.token);
    expect((await c.get(`/api/reminders?rel_id=${lead}`)).body).toEqual([]);
    expect((await c.get(`/api/notes?rel_id=${lead}`)).body).toEqual([]);
    expect((await c.get(`/api/files?rel_id=${lead}`)).body).toEqual([]);
    const before = await snapshot();
    const statuses = [
      (await c.put(`/api/reminders/${rem}`, { description: "x" })).status,
      (await c.patch(`/api/reminders/${rem}/complete`, {})).status,
      (await c.del(`/api/reminders/${rem}`)).status,
      (await c.put(`/api/notes/${note}`, { description: "x" })).status,
      (await c.del(`/api/notes/${note}`)).status,
      (await c.del(`/api/files/${file}`)).status,
      (await c.put(`/api/leads/conversions/${conv}`, { treatment_amount: 1 })).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(diff(before, await snapshot())).toBe("none");
  });
  test("[tenant] bulk-delete [A, B] -> only A's lead deleted", async () => {
    const a = await mkLead(A);
    const b = await mkLead(B);
    const r = await client(A.users.admin.token).post("/api/leads/bulk-delete", { ids: [a, b] });
    expect(r.status).toBe(200);
    expect(r.body.deletedCount).toBe(1);
    expect(await Lead.exists({ _id: a })).toBeNull();
    expect(await Lead.exists({ _id: b })).not.toBeNull();
  });
  test("[tenant] bulk-convert [A, B] -> only A's lead converted, no B client", async () => {
    const a = await mkLead(A, { name: uid("BulkA") });
    const b = await mkLead(B, { name: uid("BulkB") });
    const bClientsBefore = await Client.countDocuments({ tenant_id: B.tenantId });
    const r = await client(A.users.admin.token).post("/api/leads/bulk-convert", { ids: [a, b] });
    expect(r.status).toBe(200);
    expect(r.body.convertedCount).toBe(1);
    expect((await Lead.findById(a)).converted).toBe(true);
    expect((await Lead.findById(b)).converted).toBe(false);
    expect(await Client.countDocuments({ tenant_id: B.tenantId })).toBe(bClientsBefore);
  });
  test("[tenant] import with tenant_id: B in the rows lands in A only", async () => {
    const name = uid("ImportCross");
    const bBefore = await Lead.countDocuments({ tenant_id: B.tenantId });
    const r = await client(A.users.admin.token).post("/api/leads/import", [{ name, tenant_id: String(B.tenantId) }]);
    expect(r.status).toBe(201);
    expect(await Lead.countDocuments({ tenant_id: B.tenantId })).toBe(bBefore);
    expect(String((await Lead.findOne({ name })).tenant_id)).toBe(String(A.tenantId));
  });
  test("[tenant] PATCH /:id/status with a B status id -> 400", async () => {
    const id = await mkLead(A);
    const r = await client(A.users.admin.token).patch(`/api/leads/${id}/status`, { status: String(B.statuses.Contacted) });
    expect(r.status).toBe(400);
  });
  test("[tenant] PUT /:id / POST / cannot point an A lead at B's status (cross-tenant ref)", async () => {
    const id = await mkLead(A);
    const c = client(A.users.admin.token);
    await c.put(`/api/leads/${id}`, { status: String(B.statuses.Contacted) });
    const created = await c.post("/api/leads", { name: uid("CrossRef"), status: String(B.statuses.Confirmed), source: String(B.sources.Facebook) });
    const saved = await Lead.findById(id);
    const createdDoc = created.body?._id ? await Lead.findById(created.body._id) : null;
    const leaks = [];
    if (String(saved.status) === String(B.statuses.Contacted)) leaks.push("PUT status=B");
    if (createdDoc && String(createdDoc.status) === String(B.statuses.Confirmed)) leaks.push("POST status=B");
    if (createdDoc && String(createdDoc.source) === String(B.sources.Facebook)) leaks.push("POST source=B");
    expect(leaks).toEqual([]);
  });
  test("[tenant] A admin cannot PATCH / DELETE B's lead status or source", async () => {
    const c = client(A.users.admin.token);
    const st = await mkStatus(B);
    const src = await mkSource(B);
    expect((await c.patch(`/api/lead-statuses/${st}`, { name: "hijack" })).status).toBe(404);
    expect((await c.del(`/api/lead-statuses/${st}`)).status).toBe(404);
    expect((await c.patch(`/api/lead-sources/${src}`, { name: "hijack" })).status).toBe(404);
    expect((await c.del(`/api/lead-sources/${src}`)).status).toBe(404);
  });
  test("[tenant] PATCH own lead status/source with tenant_id: B must NOT move it into B", async () => {
    const c = client(A.users.admin.token);
    const st = await mkStatus(A);
    const src = await mkSource(A);
    await c.patch(`/api/lead-statuses/${st}`, { tenant_id: String(B.tenantId) });
    await c.patch(`/api/lead-sources/${src}`, { tenant_id: String(B.tenantId) });
    expect([String((await LeadStatus.findById(st)).tenant_id), String((await LeadSource.findById(src)).tenant_id)])
      .toEqual([String(A.tenantId), String(A.tenantId)]);
  });
  test("[tenant] GET /api/lead-pipeline/statuses|sources returns only A's rows", async () => {
    const c = client(A.users.admin.token);
    const st = await c.get("/api/lead-pipeline/statuses");
    const src = await c.get("/api/lead-pipeline/sources");
    const foreign = [...(st.body || []), ...(src.body || [])].filter((x) => String(x.tenant_id) !== String(A.tenantId));
    expect(`foreign rows: ${foreign.length}`).toBe("foreign rows: 0");
  });
  test("[tenant] POST /api/lead-pipeline/statuses|sources with tenant_id: B must not create in B", async () => {
    const c = client(A.users.full.token);
    const stName = uid("PipeInB");
    const srcName = uid("PipeSrcInB");
    await c.post("/api/lead-pipeline/statuses", { name: stName, tenant_id: String(B.tenantId) });
    await c.post("/api/lead-pipeline/sources", { name: srcName, tenant_id: String(B.tenantId) });
    const inB = (await LeadStatus.countDocuments({ name: stName, tenant_id: B.tenantId })) + (await LeadSource.countDocuments({ name: srcName, tenant_id: B.tenantId }));
    expect(`created in B: ${inB}`).toBe("created in B: 0");
    await LeadStatus.deleteMany({ name: stName });
    await LeadSource.deleteMany({ name: srcName });
  });
  test("[tenant] POST /api/lead-pipeline/statuses without tenant_id must not create an un-tenanted status", async () => {
    const name = uid("PipeOrphan");
    await client(A.users.full.token).post("/api/lead-pipeline/statuses", { name });
    const doc = await LeadStatus.findOne({ name });
    expect(doc ? String(doc.tenant_id) : "not created").toMatch(new RegExp(`^(${A.tenantId}|not created)$`));
    await LeadStatus.deleteMany({ name });
  });
  test("[tenant] public website lead with B's key creates a lead in B only", async () => {
    const name = uid("Web B");
    const aBefore = await Lead.countDocuments({ tenant_id: A.tenantId });
    const r = await client().post(`/api/public/website-leads/${B.websiteForm.key}`, { name, email: `${seq}@web.test`, phone: "9876500001" });
    expect(r.status).toBe(201);
    const doc = await Lead.findOne({ name });
    expect(String(doc.tenant_id)).toBe(String(B.tenantId));
    expect(await Lead.countDocuments({ tenant_id: A.tenantId })).toBe(aBefore);
    expect(String((await LeadSource.findById(doc.source)).tenant_id)).toBe(String(B.tenantId));
  });
  test("[tenant] Meta webhook for A's page creates the lead in A only", async () => {
    const leadgen = uid("LEADGEN_WH_A");
    const r = await client().post("/api/webhooks/meta-leads", {
      object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: leadgen, page_id: A.meta.page_id } }] }],
    });
    expect(r.status).toBe(200);
    const docs = await Lead.find({ meta_leadgen_id: leadgen }).lean();
    expect(docs.map((d) => String(d.tenant_id))).toEqual([String(A.tenantId)]);
  });
  test("[tenant] Meta webhook for an unconnected page creates no lead anywhere", async () => {
    const leadgen = uid("LEADGEN_WH_X");
    await client().post("/api/webhooks/meta-leads", { object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: leadgen, page_id: "PAGE_NOBODY" } }] }] });
    expect(await Lead.countDocuments({ meta_leadgen_id: leadgen })).toBe(0);
  });
  test("[tenant] B admin cannot take over / sync / import / disconnect A's Meta page or delete A's web form", async () => {
    const c = client(B.users.admin.token);
    const before = await snapshot();
    expect((await c.post("/api/meta-integration/connect", { page_id: A.meta.page_id, page_access_token: "x" })).status).toBe(409);
    expect((await c.post(`/api/meta-integration/${A.meta.page_id}/sync`, {})).status).toBe(404);
    expect((await c.post(`/api/meta-integration/${A.meta.page_id}/import-leads`, {})).status).toBe(404);
    expect((await c.del(`/api/meta-integration/${A.meta.page_id}`)).status).toBe(404);
    expect((await c.del(`/api/website-lead-forms/${A.websiteForm._id}`)).status).toBe(404);
    const list = (await c.get("/api/meta-integration")).body.connections.map((x) => x.page_id);
    expect(list).not.toContain(A.meta.page_id);
    expect(diff(before, await snapshot())).toBe("none");
  });
  test("[tenant] A admin GET lists never contain B rows (leads, statuses, sources, overview)", async () => {
    const c = client(A.users.admin.token);
    const leads = (await c.get("/api/leads")).body;
    expect(leads.every((l) => String(l.tenant_id) === String(A.tenantId))).toBe(true);
    const sts = (await c.get("/api/lead-statuses")).body;
    expect(sts.every((s) => String(s.tenant_id) === String(A.tenantId))).toBe(true);
    const ov = (await c.get("/api/leads/overview")).body;
    expect(ov.leads.total).toBe(await Lead.countDocuments({ tenant_id: A.tenantId }));
  });
});

describe("4b. Staff WITHOUT tenant_id (noTenant, full Leads perms) — must never see or touch tenant data", () => {
  afterAll(async () => {
    // remove whatever an un-tenanted request managed to create
    await Lead.deleteMany({ tenant_id: null });
    await Client.deleteMany({ tenant_id: null });
    await LeadStatus.deleteMany({ tenant_id: null });
  });
  test("[noTenant] GET /api/leads returns no tenant's leads (or a clean 4xx)", async () => {
    const r = await client(A.users.noTenant.token).get("/api/leads");
    const leaked = Array.isArray(r.body) ? r.body.filter((l) => l.tenant_id).length : 0;
    const tenants = Array.isArray(r.body) ? [...new Set(r.body.map((l) => String(l.tenant_id)))].length : 0;
    expect(`status ${r.status >= 400 ? "4xx" : r.status}, leaked ${leaked} lead(s) from ${tenants} tenant(s)`)
      .toMatch(/^status (4xx|200), leaked 0 lead\(s\)/);
  });
  test("[noTenant] GET /api/leads?page=1 total / statusCounts leak nothing", async () => {
    const r = await client(A.users.noTenant.token).get("/api/leads?page=1&limit=5");
    expect(r.status >= 400 ? 0 : r.body.total).toBe(0);
  });
  test("[noTenant] GET /api/leads/overview counts nothing", async () => {
    const r = await client(A.users.noTenant.token).get("/api/leads/overview");
    expect(r.status >= 400 ? 0 : r.body.leads.total).toBe(0);
  });
  test("[noTenant] GET /api/leads/:id of an A lead -> 404", async () => {
    expect((await client(A.users.noTenant.token).get(`/api/leads/${A.leads[1]}`)).status).toBe(404);
  });
  test("[noTenant] PUT / DELETE an A lead -> 404, unchanged", async () => {
    const id = await mkLead(A);
    const c = client(A.users.noTenant.token);
    expect((await c.put(`/api/leads/${id}`, { city: "noTenant" })).status).toBe(404);
    expect((await c.del(`/api/leads/${id}`)).status).toBe(404);
    expect(await Lead.exists({ _id: id })).not.toBeNull();
  });
  test("[noTenant] bulk-convert [A lead, B lead] converts nothing", async () => {
    const a = await mkLead(A, { name: uid("NT conv A") });
    const b = await mkLead(B, { name: uid("NT conv B") });
    const r = await client(A.users.noTenant.token).post("/api/leads/bulk-convert", { ids: [a, b] });
    const converted = [(await Lead.findById(a)).converted, (await Lead.findById(b)).converted].filter(Boolean).length;
    expect(`status ${r.status} converted ${converted}`).toMatch(/^status (4\d\d) converted 0$/);
  });
  test("[noTenant] bulk-delete [A lead] deletes nothing", async () => {
    const a = await mkLead(A);
    await client(A.users.noTenant.token).post("/api/leads/bulk-delete", { ids: [a] });
    expect(await Lead.exists({ _id: a })).not.toBeNull();
  });
  test("[noTenant] POST /api/leads must not create an un-tenanted lead", async () => {
    const name = uid("NT create");
    const r = await client(A.users.noTenant.token).post("/api/leads", { name });
    const orphan = await Lead.countDocuments({ name, tenant_id: null });
    expect(`status ${r.status >= 400 ? "4xx" : r.status} orphans ${orphan}`).toBe("status 4xx orphans 0");
  });
  test("[noTenant] GET lead-statuses / reminders / notes leak no tenant rows", async () => {
    const lead = await mkLead(A);
    await mkReminder(A, lead);
    await mkNote(A, lead);
    const c = client(A.users.noTenant.token);
    const sts = (await c.get("/api/lead-statuses")).body || [];
    const rems = (await c.get("/api/reminders")).body || [];
    const notes = (await c.get("/api/notes")).body || [];
    const count = (arr) => (Array.isArray(arr) ? arr.filter((x) => x.tenant_id).length : 0);
    expect({ statuses: count(sts), reminders: count(rems), notes: count(notes) }).toEqual({ statuses: 0, reminders: 0, notes: 0 });
  });
});

// ================================================================= 5. LINKS
describe("5. Links — convert, deleted refs, rel_id children, counts", () => {
  test("[link] convert (patient_conversion ON) -> Client + primary Contact + LeadConversion + status Customer", async () => {
    const name = uid("Convert Me");
    const email = `${uid("conv").toLowerCase()}@example.com`;
    const id = await mkLead(A, {
      name: `${name} Patel`, company: `${name} Co`, phonenumber: "+91 9876512345", email: email,
      address: "12 MG Road", city: "Ahmedabad", state: "Gujarat", zip: "380001", country: "India", website: "conv.example.com",
      assigned: A.users.full.id,
    });
    const r = await client(A.users.full.token).post(`/api/leads/${id}/convert`, { treatment_item: String(A.items[0]), treatment_amount: 5000 });
    expect(r.status).toBe(201);
    const lead = await Lead.findById(id);
    expect(lead.converted).toBe(true);
    expect(String(lead.status)).toBe(String(A.statuses.Customer));
    const cl = await Client.findById(lead.client_id).lean();
    expect(cl).toMatchObject({
      company: `${name} Co`, phonenumber: "+91 9876512345", email: email, address: "12 MG Road",
      city: "Ahmedabad", state: "Gujarat", zip: "380001", country: "India", website: "conv.example.com",
    });
    expect(String(cl.tenant_id)).toBe(String(A.tenantId));
    const contact = await Contact.findOne({ userid: cl._id }).lean();
    expect(contact).toMatchObject({ is_primary: true, firstname: name.split(" ")[0], email: email });
    const conv = await LeadConversion.findOne({ lead: id }).lean();
    expect(conv).toMatchObject({ treatment_amount: 5000, treatment_name: "Root Canal A" });
    expect(String(conv.client)).toBe(String(cl._id));
    expect(String(conv.tenant_id)).toBe(String(A.tenantId));
    // second convert is refused
    expect((await client(A.users.full.token).post(`/api/leads/${id}/convert`, { treatment_name: "again", treatment_amount: 1 })).status).toBe(409);
  });
  test("[link] convert with feature OFF (legacy) -> Client, status Customer, no LeadConversion", async () => {
    await setFeatures(B.tenantId, []);
    try {
      const id = await mkLead(B, { name: uid("Legacy"), email: `${seq}.leg@example.com` });
      const r = await client(B.users.admin.token).post(`/api/leads/${id}/convert`, {});
      expect(r.status).toBe(201);
      const lead = await Lead.findById(id);
      expect(lead.converted).toBe(true);
      expect(String(lead.status)).toBe(String(B.statuses.Customer));
      expect(await Client.exists({ _id: lead.client_id, tenant_id: B.tenantId })).not.toBeNull();
      expect(await LeadConversion.countDocuments({ lead: id })).toBe(0);
    } finally {
      await setFeatures(B.tenantId, ["lead_followups", "patient_conversion"]);
    }
  });
  test("[link] DELETE a status / source still used by leads -> 400 and kept", async () => {
    const st = await mkStatus(A);
    const src = await mkSource(A);
    await mkLead(A, { status: st, source: src });
    const c = client(A.users.admin.token);
    expect((await c.del(`/api/lead-statuses/${st}`)).status).toBe(400);
    expect((await c.del(`/api/lead-sources/${src}`)).status).toBe(400);
    expect(await LeadStatus.exists({ _id: st })).not.toBeNull();
    expect(await LeadSource.exists({ _id: src })).not.toBeNull();
  });
  test("[link] if a used status/source disappears anyway, lists still load (status/source null)", async () => {
    const st = await mkStatus(A);
    const src = await mkSource(A);
    const name = uid("Orphan ref");
    const id = await mkLead(A, { name, status: st, source: src });
    await LeadStatus.deleteOne({ _id: st });
    await LeadSource.deleteOne({ _id: src });
    const c = client(A.users.admin.token);
    const list = await c.get(`/api/leads?page=1&limit=10&search=${encodeURIComponent(name)}`);
    expect(list.status).toBe(200);
    const row = list.body.data.find((l) => String(l._id) === String(id));
    expect(row.status).toBeNull();
    expect(row.source).toBeNull();
    const one = await c.get(`/api/leads/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.status).toBeNull();
    observations.push(`deleted status: statusCounts keeps a bucket for the vanished status id ${st} -> ${JSON.stringify(list.body.statusCounts.find((s) => s.status === String(st)) || null)}`);
  });
  test("[link] deleting / deactivating the assigned staff — leads still load", async () => {
    const sid = new mongoose.Types.ObjectId();
    await Staff.create({ _id: sid, firstname: "Gone", lastname: "Staff", email: `${uid("gone")}@leads-test.local`, password: "password123", active: true, tenant_id: A.tenantId });
    const name = uid("Assigned to gone");
    const id = await mkLead(A, { name, assigned: sid });
    const c = client(A.users.admin.token);
    await Staff.updateOne({ _id: sid }, { active: false });
    const whileInactive = await c.get(`/api/leads/${id}`);
    expect(whileInactive.status).toBe(200);
    observations.push(`inactive assignee: GET /:id assigned = ${JSON.stringify(whileInactive.body.assigned)}`);
    expect((await c.del(`/api/staff/${sid}`)).status).toBe(200);
    const list = await c.get(`/api/leads?page=1&limit=10&search=${encodeURIComponent(name)}`);
    expect(list.status).toBe(200);
    const row = list.body.data.find((l) => String(l._id) === String(id));
    const one = await c.get(`/api/leads/${id}`);
    expect(one.status).toBe(200);
    observations.push(`deleted assignee: list row assigned = ${JSON.stringify(row.assigned)} (dangling id, list never populates assigned); GET /:id assigned = ${JSON.stringify(one.body.assigned)}`);
    expect(one.body.assigned).toBeNull();
  });
  test("[link] reminders / notes / tasks / files hang off the lead by rel_id", async () => {
    const id = await mkLead(A, { name: uid("Linked") });
    const c = client(A.users.admin.token);
    expect((await c.post("/api/reminders", { description: "call back", date: new Date(Date.now() + 3600e3).toISOString(), rel_id: String(id), rel_type: "lead" })).status).toBe(201);
    expect((await c.post("/api/notes", { rel_id: String(id), rel_type: "lead", description: "linked note" })).status).toBe(201);
    expect((await c.post("/api/tasks", { name: uid("Linked task"), related_to: "lead", rel_id: String(id) })).status).toBe(201);
    expect((await uploadFile(A.users.admin.token, id)).status).toBe(201);
    expect((await c.get(`/api/reminders?rel_type=lead&rel_id=${id}`)).body).toHaveLength(1);
    expect((await c.get(`/api/notes?rel_type=lead&rel_id=${id}`)).body).toHaveLength(1);
    expect((await c.get(`/api/tasks?rel_type=lead&rel_id=${id}`)).body).toHaveLength(1);
    expect((await c.get(`/api/files?rel_type=lead&rel_id=${id}`)).body).toHaveLength(1);
    expect((await c.get(`/api/notes/exists?rel_type=lead&rel_ids=${id}`)).body).toEqual([String(id)]);
    await settle(200);
    expect((await Lead.findById(id)).followup_date).toBeTruthy(); // reminder synced onto the lead
    expect((await c.del(`/api/leads/${id}`)).status).toBe(200);
    const left = {
      reminders: await Reminder.countDocuments({ rel_id: id }), notes: await Note.countDocuments({ rel_id: id }),
      tasks: await Task.countDocuments({ rel_id: id }), files: await FileM.countDocuments({ rel_id: id }),
    };
    observations.push(`after DELETE /api/leads/:id the children are left behind (no cascade): ${JSON.stringify(left)}`);
  });
  test("[link] overview reminder counts drop when the lead with the reminder is deleted", async () => {
    const id = await mkLead(A);
    await mkReminder(A, id, { date: new Date(Date.now() + 86400000 * 4) });
    const c = client(A.users.admin.token);
    const before = (await c.get("/api/leads/overview")).body.reminders.upcoming;
    expect((await c.del(`/api/leads/${id}`)).status).toBe(200);
    const after = (await c.get("/api/leads/overview")).body.reminders.upcoming;
    expect(after).toBe(before - 1);
  });
  test("[link] GET /api/lead-statuses totalLeads == DB count per status", async () => {
    const r = await client(A.users.admin.token).get("/api/lead-statuses");
    expect(r.status).toBe(200);
    const db = await dbStatusCounts({ tenant_id: A.tenantId });
    for (const s of r.body) expect([s.name, s.totalLeads]).toEqual([s.name, db[String(s._id)] || 0]);
  });
});
