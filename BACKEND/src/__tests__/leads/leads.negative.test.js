// Leads module — NEGATIVE API tests: every Add/Edit field (POST and PUT), reminders, notes,
// attachments, tasks, convert, import, delete cascade, Meta webhook, public website form.
// In-memory MongoDB + faked Graph API only (see leadsStack.cjs).
// Each test name states the CORRECT behaviour; a failing test = an app bug (or a product
// decision to confirm). Convention: "rejected" = 4xx (never 500) and nothing saved / DB unchanged.
// HTML/script inputs: XSS is a rendering concern, so those tests only assert the API stores the
// text verbatim as plain JSON data and are tagged "needs UI check".
jest.setTimeout(180000);

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client, guard, graph } = require("./leadsStack.cjs");

let baseUrl, A, B, admin, pilot;
let Lead, LeadStatus, CustomField, CustomFieldValue, Reminder, Note, Task, File, Client, LeadConversion, Setting, HRMSBranch, WebsiteLeadForm;
let deletedStatusId, bOnlyField;
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
const N = (n, ch = "a") => ch.repeat(n);
const XSS = "<script>alert(1)</script>";
const OMIT = Symbol("omit");
const HARDCODED_TENANT = "6a644ea61aa686e76f53d7a2";
const logs = []; // everything the app wrote to console.* while these tests ran

let seq = 0;
const uniqName = () => `NegLead ${++seq} ${Date.now()}`;
const val = (v) => (typeof v === "function" ? v() : v);

// A valid create payload (incl. the tenant's REQUIRED custom field) — each test changes one field.
const basePayload = () => ({
  name: uniqName(),
  status: String(A.statuses.New),
  source: String(A.sources.Website),
  custom_fields: { leads_budget_range: "10k-20k" },
});

const postLead = async (field, value, token = admin) => {
  const body = basePayload();
  if (value === OMIT) delete body[field];
  else body[field] = val(value);
  const before = await Lead.countDocuments({ tenant_id: A.tenantId });
  const r = await client(token).post("/api/leads", body);
  const after = await Lead.countDocuments({ tenant_id: A.tenantId });
  const doc = r.body && r.body._id ? await Lead.findById(r.body._id).lean() : null;
  return { status: r.status, saved: after - before, body: r.body, doc };
};

// PUT one field on an existing valid lead, then restore the raw document exactly.
let putTarget;
const putLead = async (field, value, token = admin) => {
  const before = await Lead.collection.findOne({ _id: putTarget });
  const r = await client(token).put(`/api/leads/${putTarget}`, { [field]: val(value) });
  const after = await Lead.collection.findOne({ _id: putTarget });
  await Lead.collection.replaceOne({ _id: putTarget }, before);
  return {
    status: r.status, body: r.body,
    changed: JSON.stringify(after?.[field]) !== JSON.stringify(before?.[field]),
    stored: after?.[field],
  };
};

const uploadFile = async (token, relId, name, content, type) => {
  const fd = new FormData();
  fd.append("rel_id", String(relId));
  fd.append("rel_type", "lead");
  fd.append("files", new Blob([content], { type }), name);
  const res = await fetch(`${baseUrl}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
};

const newLead = async (extra = {}) =>
  Lead.create({ name: uniqName(), status: A.statuses.New, source: A.sources.Website, tenant_id: A.tenantId, addedfrom: A.users.admin.id, ...extra });

beforeAll(async () => {
  for (const m of ["log", "error", "warn"]) {
    jest.spyOn(console, m).mockImplementation((...a) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" "));
    });
  }
  ({ baseUrl } = await start());
  ({ A, B } = await seedAll());
  admin = A.users.admin.token;
  pilot = A.users.pilot.token;
  Lead = require("../../models/Lead");
  LeadStatus = require("../../models/LeadStatus");
  CustomField = require("../../models/CustomField");
  CustomFieldValue = require("../../models/CustomFieldValue");
  Reminder = require("../../models/Reminder");
  Note = require("../../models/Note");
  Task = require("../../models/Task");
  File = require("../../models/File");
  Client = require("../../models/Client");
  LeadConversion = require("../../models/LeadConversion");
  Setting = require("../../models/Setting");
  HRMSBranch = require("../../hrms/models/hrms_branch_model");
  WebsiteLeadForm = require("../../models/WebsiteLeadForm");
  // Production has these unique indexes built; make sure the in-memory DB has them too.
  for (const M of [Lead, Client, LeadConversion, CustomFieldValue]) await M.init();

  const tmp = await LeadStatus.create({ name: "Temp Deleted", tenant_id: A.tenantId, statusorder: 9 });
  deletedStatusId = tmp._id;
  await LeadStatus.deleteOne({ _id: tmp._id });
  await CustomField.create({ name: "Age", slug: "leads_age", fieldto: "leads", type: "number", tenant_id: A.tenantId });
  bOnlyField = await CustomField.create({ name: "B Secret", slug: "leads_b_secret", fieldto: "leads", type: "input", tenant_id: B.tenantId });
  await HRMSBranch.create({ name: "A Main Branch", tenant_id: A.tenantId });
  await HRMSBranch.create({ name: "B Only Branch", tenant_id: B.tenantId });

  putTarget = (await Lead.create({
    name: "Put Target Lead", title: "Manager", email: "put.target@example.com", phonenumber: "9123456780",
    status: A.statuses.New, source: A.sources.Website, tenant_id: A.tenantId, addedfrom: A.users.admin.id,
    company: "Put Co", city: "Surat", lead_value: "500",
  }))._id;
});

afterAll(async () => {
  try {
    for (const f of fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []) {
      if (f.includes("leadsneg-")) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch { /* gone */ } }
    }
  } finally {
    expect(guard.realFacebookCalls).toBe(0);
    await stop();
    jest.restoreAllMocks();
  }
});

// ======================================================================================
// FIELD TABLE — every value here must be REJECTED (4xx, nothing saved) on POST and PUT.
// [field, label, value, opts]  value may be a function (resolved after seeding).
// ======================================================================================
const REJECT = [
  ["branch", "name that does not exist (pilot user)", "No Such Branch", { token: "pilot" }],
  ["branch", "Tenant B's branch name (pilot user)", "B Only Branch", { token: "pilot" }],
  ["status", "'abc'", "abc"],
  ["status", "Tenant B's status id", () => String(B.statuses.New)],
  ["status", "deleted status id", () => String(deletedStatusId)],
  ["source", "'abc'", "abc"],
  ["source", "Tenant B's source id", () => String(B.sources.Website)],
  ["assigned", "'abc'", "abc"],
  ["assigned", "Tenant B's staff id", () => String(B.users.full.id)],
  ["assigned", "inactive staff", () => String(A.users.inactive.id)],
  ["assigned", "non-existent staff id", () => String(new mongoose.Types.ObjectId())],
  ["salesPerson", "free text that is not a staff member", "Nobody Real 123"],
  ["tags", "500 chars", N(500)],
  ["name", "empty", ""],
  ["name", "spaces only", "   "],
  ["name", "500 chars", N(500)],
  ["title", "500 chars", N(500)],
  ["email", "'abc'", "abc"],
  ["email", "'a@'", "a@"],
  ["email", "'a@b'", "a@b"],
  ["email", "space inside 'a b@x.com'", "a b@x.com"],
  ["website", "'abc'", "abc"],
  ["website", "'javascript:alert(1)'", "javascript:alert(1)"],
  ["website", "1000 chars", "https://" + N(1000) + ".com"],
  ["phonenumber", "letters", "abcdefghij"],
  ["phonenumber", "9 digits", "987654321"],
  ["phonenumber", "20 digits", N(20, "9")],
  ["lead_value", "-100", -100],
  ["lead_value", "1e15", 1e15],
  ["lead_value", "'abc'", "abc"],
  ["company", "500 chars", N(500)],
  ["city", "1000 chars", N(1000)],
  ["state", "1000 chars", N(1000)],
  ["country", "not in the UI country list ('Atlantis')", "Atlantis"],
  ["zip", "letters only", "ABCDEF"],
  ["zip", "50 chars", N(50, "1")],
  ["default_language", "not in LANGUAGE_NAMES ('Klingon')", "Klingon"],
  ["description", "50,000 chars", N(50000)],
  ["followup_date", "'2026-02-30' (impossible date)", "2026-02-30"],
  ["followup_date", "'abc'", "abc"],
  ["followup_date", "far future 9999-12-31", "9999-12-31"],
];
const tokenFor = (opts) => (opts && opts.token === "pilot" ? pilot : admin);

describe("Every field — POST /api/leads must reject bad input (4xx, nothing saved)", () => {
  const POST_ONLY = [
    ["status", "missing (Status *)", OMIT],
    ["source", "missing (Source *)", OMIT],
  ];
  test.each([...POST_ONLY, ...REJECT])("[-] POST %s = %s -> rejected", async (...row) => {
    const [field, , value, opts] = row; // rest param: jest-each must not see a 4th arg as `done`
    const r = await postLead(field, value, tokenFor(opts));
    expect(`${r.status} saved=${r.saved}`).toMatch(/^4\d\d saved=0$/);
  });
});

describe("Every field — PUT /api/leads/:id must reject bad input (4xx, DB unchanged)", () => {
  test.each(REJECT)("[-] PUT %s = %s -> rejected", async (...row) => {
    const [field, , value, opts] = row;
    const r = await putLead(field, value, tokenFor(opts));
    expect(`${r.status} changed=${r.changed}`).toMatch(/^4\d\d changed=false$/);
  });
});

describe("Valid-but-unusual input must be ACCEPTED (no false negatives)", () => {
  test.each([
    ["name", "1 char", "X", "X"],
    ["name", "emoji", "Ravi 😀 Shah", "Ravi 😀 Shah"],
    ["email", "UPPER@CASE.COM is stored lowercase", "UPPER@CASE.COM", "upper@case.com"],
    ["email", "spaces around are trimmed", "  trim.me@example.com  ", "trim.me@example.com"],
    ["phonenumber", "'+91 98765 11111'", "+91 98765 11111", "+91 98765 11111"],
    ["lead_value", "0", 0, "0"],
    ["lead_value", "1.555 (kept as given)", 1.555, "1.555"],
    ["address", "1000 chars", N(1000), N(1000)],
    ["city", "emoji", "Surat 🏙️", "Surat 🏙️"],
    ["tags", "empty", "", ""],
    ["tags", "emoji", "vip,🔥hot", "vip,🔥hot"],
    ["branch", "Tenant A's own branch name (pilot user)", "A Main Branch", "A Main Branch"],
    ["followup_date", "past date (logging a missed follow-up)", "2025-01-15T10:00:00.000Z", new Date("2025-01-15T10:00:00.000Z").toISOString()],
  ])("[+] POST %s = %s -> 201", async (field, label, value, expected) => {
    const r = await postLead(field, value, field === "branch" ? pilot : admin);
    expect(r.status).toBe(201);
    const stored = r.doc[field] instanceof Date ? r.doc[field].toISOString() : r.doc[field];
    expect(stored).toBe(expected);
  });

  test("[+] phone '+91 9876543210' -> phone_last10 = '9876543210' in DB", async () => {
    const r = await postLead("phonenumber", "+91 9876543210");
    expect(r.status).toBe(201);
    expect(r.doc.phone_last10).toBe("9876543210");
  });

  test.each([["is_public", "yes", true], ["is_public", "no", false], ["contacted_today", "yes", true], ["contacted_today", "no", false]])(
    "[+] %s = '%s' (string) -> stored as boolean %s",
    async (field, value, expected) => {
      const r = await postLead(field, value);
      expect(r.status).toBe(201);
      expect(r.doc[field]).toBe(expected);
    }
  );

  test("[+] PUT title = '' clears Position on edit", async () => {
    const r = await putLead("title", "");
    expect(r.status).toBe(200);
    expect(r.stored).toBe("");
  });

  test("[+] duplicate NAME in the same tenant is allowed on create (people share names)", async () => {
    const r = await postLead("name", "Lead A00");
    expect(r.status).toBe(201);
  });
});

describe("HTML / script / formula input — stored verbatim as plain text (needs UI check)", () => {
  test.each([
    ["name", XSS],
    ["name", "=1+1"],
    ["title", "<b>CEO</b><img src=x onerror=alert(1)>"],
    ["company", "<i>Acme</i>"],
    ["address", XSS],
    ["city", "<b>Surat</b>"],
    ["state", "<u>Gujarat</u>"],
    ["description", `<div onclick="alert(1)">hi</div>${XSS}`],
    ["tags", XSS],
  ])("[~] POST %s = %s -> stored verbatim, JSON response (needs UI check / CSV-formula check on export)", async (field, value) => {
    const r = await postLead(field, value);
    expect(r.status).toBe(201);
    expect(r.doc[field]).toBe(value);
    const g = await client(admin).get(`/api/leads/${r.doc._id}`);
    expect(g.headers.get("content-type")).toMatch(/application\/json/);
  });

  test("[-] tags ',,,' -> empty tags are dropped (stored '') or rejected", async () => {
    const r = await postLead("tags", ",,,");
    if (r.status === 201) expect(r.doc.tags).toBe("");
    else expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Duplicate detection (Setup > Settings > Leads > duplicate fields)", () => {
  test("[+] default (setting off): duplicate email / phone of another lead are allowed", async () => {
    const e = await postLead("email", "lead0.a@example.com");
    const p = await postLead("phonenumber", "+91 9876543200");
    expect([e.status, p.status]).toEqual([201, 201]);
  });

  describe("with leadDuplicateFields = [email, phone]", () => {
    beforeAll(async () => { await Setting.create({ name: "leadDuplicateFields", value: ["email", "phone"], tenant_id: A.tenantId }); });
    afterAll(async () => { await Setting.deleteMany({ name: "leadDuplicateFields" }); });

    test("[-] POST duplicate email in other case -> 409", async () => {
      expect((await postLead("email", "LEAD0.A@EXAMPLE.COM")).status).toBe(409);
    });
    test("[-] POST same phone written differently ('9876543200' vs '+91 9876543200') -> 409 (match on phone_last10)", async () => {
      const r = await postLead("phonenumber", "9876543200");
      expect(`${r.status} saved=${r.saved}`).toBe("409 saved=0");
    });
    test("[-] PUT another lead's email onto a lead -> 409, DB unchanged", async () => {
      const r = await putLead("email", "lead0.a@example.com");
      expect(`${r.status} changed=${r.changed}`).toBe("409 changed=false");
    });
  });
});

describe("Custom fields on leads", () => {
  test("[-] POST without the tenant's REQUIRED custom field -> 400, nothing saved", async () => {
    const body = basePayload();
    delete body.custom_fields;
    const before = await Lead.countDocuments({ tenant_id: A.tenantId });
    const r = await client(admin).post("/api/leads", body);
    const saved = (await Lead.countDocuments({ tenant_id: A.tenantId })) - before;
    expect(`${r.status} saved=${saved}`).toMatch(/^4\d\d saved=0$/);
  });
  test("[-] POST required custom field = '   ' -> 400", async () => {
    const r = await client(admin).post("/api/leads", { ...basePayload(), custom_fields: { leads_budget_range: "   " } });
    expect(r.status).toBe(400);
  });
  test("[-] POST number custom field = 'abc' (wrong type) -> 400", async () => {
    const r = await client(admin).post("/api/leads", { ...basePayload(), custom_fields: { leads_budget_range: "x", leads_age: "abc" } });
    expect(r.status).toBe(400);
  });
  test("[-] POST with Tenant B's custom-field slug -> value never written into B's field", async () => {
    const r = await client(admin).post("/api/leads", { ...basePayload(), custom_fields: { leads_budget_range: "x", leads_b_secret: "leak" } });
    expect(r.status).toBeLessThan(500);
    expect(await CustomFieldValue.countDocuments({ fieldid: bOnlyField._id })).toBe(0);
  });
  test("[-] POST with Tenant B's custom-field _id as key -> value never written into B's field", async () => {
    const r = await client(admin).post("/api/leads", { ...basePayload(), custom_fields: { leads_budget_range: "x", [String(bOnlyField._id)]: "leak" } });
    expect(r.status).toBeLessThan(500);
    expect(await CustomFieldValue.countDocuments({ fieldid: bOnlyField._id })).toBe(0);
  });
  test("[-] PUT custom_fields -> value is saved (edit must not silently drop custom fields)", async () => {
    const r = await client(admin).put(`/api/leads/${putTarget}`, { custom_fields: { leads_budget_range: "edited-value" } });
    expect(r.status).toBe(200);
    const v = await CustomFieldValue.findOne({ relid: putTarget, fieldid: A.requiredField._id }).lean();
    expect(v && v.value).toBe("edited-value");
  });
});

// ======================================================================================
describe("Auth, ids, permissions, mass assignment", () => {
  test("[-] no token -> 401", async () => {
    expect((await client(null).get("/api/leads")).status).toBe(401);
    expect((await client(null).post("/api/leads", basePayload())).status).toBe(401);
  });
  test("[-] bad token -> 401", async () => {
    expect((await client("not.a.jwt").get("/api/leads")).status).toBe(401);
    expect((await client("not.a.jwt").put(`/api/leads/${putTarget}`, { name: "x" })).status).toBe(401);
  });
  test("[-] inactive user's token -> 401", async () => {
    expect((await client(A.users.inactive.token).get("/api/leads")).status).toBe(401);
  });
  test("[-] user with NO tenant must not see other companies' leads (403 or empty list)", async () => {
    const r = await client(A.users.noTenant.token).get("/api/leads");
    const n = Array.isArray(r.body) ? r.body.length : 0;
    expect(`${r.status} leads=${r.status === 200 ? n : 0}`).toMatch(/^(40\d leads=0|200 leads=0)$/);
  });
  test("[-] View-only staff (no Create) POST /api/leads -> 403, nothing saved", async () => {
    const r = await postLead("name", uniqName(), A.users.viewOnly.token);
    expect(`${r.status} saved=${r.saved}`).toBe("403 saved=0");
  });
  test("[-] View-only staff (no Edit) PUT /api/leads/:id -> 403, DB unchanged", async () => {
    const r = await putLead("name", "Hijacked", A.users.viewOnly.token);
    expect(`${r.status} changed=${r.changed}`).toBe("403 changed=false");
  });
  test("[-] View-only staff (no Delete) DELETE /api/leads/:id -> 403, lead kept", async () => {
    const l = await newLead();
    const r = await client(A.users.viewOnly.token).del(`/api/leads/${l._id}`);
    expect(`${r.status} exists=${!!(await Lead.exists({ _id: l._id }))}`).toBe("403 exists=true");
  });

  test.each([
    ["GET", "/api/leads/abc"],
    ["PUT", "/api/leads/abc"],
    ["DELETE", "/api/leads/abc"],
    ["PATCH", "/api/leads/abc/status"],
    ["PATCH", "/api/leads/abc/lost"],
    ["PATCH", "/api/leads/abc/junk"],
    ["POST", "/api/leads/abc/convert"],
  ])("[-] invalid id: %s %s -> 400/404, never 500", async (m, p) => {
    const api = client(admin);
    const body = { name: "x", status: String(A.statuses.New) };
    const r = await { GET: api.get, PUT: api.put, DELETE: api.del, PATCH: api.patch, POST: api.post }[m](p, m === "GET" || m === "DELETE" ? undefined : body);
    expect(`${m} ${p} -> ${r.status}`).toMatch(/-> 40[04]$/);
  });

  const PROTECTED = () => ({
    _id: String(new mongoose.Types.ObjectId()), tenant_id: String(B.tenantId), converted: true,
    client_id: String(new mongoose.Types.ObjectId()), origin: "whatsapp", createdAt: "2000-01-01T00:00:00.000Z", phone_last10: "0000000000",
  });
  test("[-] POST ignores _id / tenant_id / converted / client_id / origin / createdAt / phone_last10", async () => {
    const p = PROTECTED();
    const r = await client(admin).post("/api/leads", { ...basePayload(), ...p });
    expect(r.status).toBe(201);
    const db = await Lead.findById(r.body._id).lean();
    expect(String(db._id)).not.toBe(p._id);
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
    expect(db.converted).toBe(false);
    expect(db.client_id).toBeUndefined();
    expect(db.origin).toBe("");
    expect(new Date(db.createdAt).getFullYear()).not.toBe(2000);
    expect(db.phone_last10).toBeUndefined();
  });
  test("[-] PUT ignores _id / tenant_id / converted / client_id / origin / createdAt / phone_last10", async () => {
    const before = await Lead.collection.findOne({ _id: putTarget });
    const r = await client(admin).put(`/api/leads/${putTarget}`, PROTECTED());
    const after = await Lead.collection.findOne({ _id: putTarget });
    await Lead.collection.replaceOne({ _id: putTarget }, before);
    expect(r.status).toBe(200);
    expect(String(after.tenant_id)).toBe(String(A.tenantId));
    expect(after.converted).toBe(false);
    expect(after.client_id).toBeUndefined();
    expect(after.origin).toBe("");
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.phone_last10).toBe(before.phone_last10);
  });
  test("[-] POST addedfrom = Tenant B's staff id -> ignored (creator is the caller) or 400", async () => {
    const r = await client(admin).post("/api/leads", { ...basePayload(), addedfrom: String(B.users.admin.id) });
    if (r.status === 201) expect(String((await Lead.findById(r.body._id).lean()).addedfrom)).toBe(String(A.users.admin.id));
    else expect(r.status).toBe(400);
  });
});

// ======================================================================================
describe("Reminders on a lead", () => {
  let lead;
  beforeAll(async () => { lead = await newLead(); });
  const post = (patch) => client(admin).post("/api/reminders", {
    description: "Call back", date: new Date(Date.now() + 86400000).toISOString(), staff: String(A.users.full.id),
    rel_id: String(lead._id), rel_type: "lead", ...patch,
  });
  const count = () => Reminder.countDocuments({ rel_id: lead._id });

  test("[-] date in the past -> 400", async () => {
    const before = await count();
    const r = await post({ date: "2020-01-01T10:00:00.000Z" });
    expect(`${r.status} saved=${(await count()) - before}`).toMatch(/^400 saved=0$/);
  });
  test("[-] date 'abc' -> 400 'A valid follow-up date/time is required'", async () => {
    const r = await post({ date: "abc" });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("A valid follow-up date/time is required");
  });
  test("[-] staff = Tenant B's staff id -> 400, nothing saved", async () => {
    const before = await count();
    const r = await post({ staff: String(B.users.full.id) });
    expect(`${r.status} saved=${(await count()) - before}`).toMatch(/^4\d\d saved=0$/);
  });
  test("[-] staff = 'abc' -> 400 (not silently re-assigned to the caller)", async () => {
    const before = await count();
    const r = await post({ staff: "abc" });
    expect(`${r.status} saved=${(await count()) - before}`).toMatch(/^4\d\d saved=0$/);
  });
  test.each([["empty", ""], ["spaces only", "    "]])("[-] description %s -> 400 'A reminder note is required'", async (l, d) => {
    const r = await post({ description: d });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("A reminder note is required");
  });
  test("[~] description 5000 chars -> accepted but cut to 2000", async () => {
    const r = await post({ description: N(5000) });
    expect(r.status).toBe(201);
    expect((await Reminder.findById(r.body._id).lean()).description.length).toBe(2000);
  });
  test("[-] rel_id = Tenant B's lead -> 404", async () => {
    const r = await post({ rel_id: String(B.leads[0]) });
    expect(r.status).toBe(404);
  });
});

describe("Notes on a lead", () => {
  let lead;
  beforeAll(async () => { lead = await newLead(); });
  const post = (patch) => client(admin).post("/api/notes", { rel_id: String(lead._id), rel_type: "lead", description: "ok", ...patch });

  test("[-] spaces only -> 400, nothing saved", async () => {
    const before = await Note.countDocuments({ rel_id: lead._id });
    const r = await post({ description: "     " });
    expect(`${r.status} saved=${(await Note.countDocuments({ rel_id: lead._id })) - before}`).toMatch(/^400 saved=0$/);
  });
  test("[-] 50,000 chars -> 400 (or capped)", async () => {
    const r = await post({ description: N(50000) });
    if (r.status === 201) expect((await Note.findById(r.body._id).lean()).description.length).toBeLessThanOrEqual(10000);
    else expect(r.status).toBe(400);
  });
  test("[~] HTML -> stored verbatim (needs UI check)", async () => {
    const r = await post({ description: XSS });
    expect(r.status).toBe(201);
    expect(r.body.description).toBe(XSS);
  });
  test("[-] note on Tenant B's lead -> 404, nothing saved", async () => {
    const before = await Note.countDocuments({ rel_id: B.leads[0] });
    const r = await post({ rel_id: String(B.leads[0]) });
    expect(`${r.status} saved=${(await Note.countDocuments({ rel_id: B.leads[0] })) - before}`).toBe("404 saved=0");
  });
});

describe("Attachments on a lead (POST /api/files)", () => {
  let lead;
  beforeAll(async () => { lead = await newLead(); });

  test("[-] wrong type (.exe) -> 400, nothing saved", async () => {
    const before = await File.countDocuments({ rel_id: lead._id });
    const r = await uploadFile(admin, lead._id, "leadsneg-virus.exe", "MZ fake", "application/octet-stream");
    expect(`${r.status} saved=${(await File.countDocuments({ rel_id: lead._id })) - before}`).toBe("400 saved=0");
  });
  test("[-] file > 10MB (UI limit, LeadAttachmentsTab.tsx:20) -> 400, nothing saved", async () => {
    const before = await File.countDocuments({ rel_id: lead._id });
    const r = await uploadFile(admin, lead._id, "leadsneg-big.pdf", Buffer.alloc(11 * 1024 * 1024, 97), "application/pdf");
    expect(`${r.status} saved=${(await File.countDocuments({ rel_id: lead._id })) - before}`).toBe("400 saved=0");
  });
  test("[-] upload onto Tenant B's lead -> 404, nothing saved", async () => {
    const before = await File.countDocuments({ rel_id: B.leads[0] });
    const r = await uploadFile(admin, B.leads[0], "leadsneg-cross.txt", "hello", "text/plain");
    expect(`${r.status} saved=${(await File.countDocuments({ rel_id: B.leads[0] })) - before}`).toBe("404 saved=0");
  });
  test("[-] rel_id 'abc' -> 400, never 500", async () => {
    const r = await uploadFile(admin, "abc", "leadsneg-badrel.txt", "hello", "text/plain");
    expect(r.status).toBe(400);
  });
});

describe("Tasks on a lead (title)", () => {
  let lead;
  beforeAll(async () => { lead = await newLead(); });
  const post = (name) => client(admin).post("/api/tasks", { name, related_to: "lead", rel_id: String(lead._id) });
  test("[-] title spaces only -> 400", async () => {
    expect((await post("    ")).status).toBe(400);
  });
  test("[-] title 500 chars -> 400", async () => {
    const before = await Task.countDocuments({ rel_id: lead._id });
    const r = await post(N(500));
    expect(`${r.status} saved=${(await Task.countDocuments({ rel_id: lead._id })) - before}`).toMatch(/^4\d\d saved=0$/);
  });
});

// ======================================================================================
describe("Convert lead (patient_conversion ON)", () => {
  beforeAll(async () => { await setFeatures(A.tenantId, ["patient_conversion"]); });
  afterAll(async () => { await setFeatures(A.tenantId, []); });
  const convert = async (body, lead) => {
    lead = lead || (await newLead());
    return { lead, r: await client(admin).post(`/api/leads/${lead._id}/convert`, body) };
  };

  test("[-] treatment name spaces only + no item -> 400 'Select a treatment or enter a treatment name'", async () => {
    const { r } = await convert({ treatment_name: "    ", treatment_amount: 100 });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Select a treatment or enter a treatment name");
  });
  test("[-] treatment name empty + no item -> 400 same message", async () => {
    const { r } = await convert({ treatment_amount: 100 });
    expect(r.body.message).toBe("Select a treatment or enter a treatment name");
  });
  test("[-] treatment_item of Tenant B -> 400 'Selected treatment was not found'", async () => {
    const { r } = await convert({ treatment_item: String(B.items[0]), treatment_amount: 100 });
    expect(`${r.status} ${r.body.message}`).toBe("400 Selected treatment was not found");
  });
  test.each([["-1", -1], ["'abc'", "abc"], ["empty ''", ""]])("[-] amount %s -> 400, lead stays unconverted", async (l, amount) => {
    const { r, lead } = await convert({ treatment_name: "Root canal", treatment_amount: amount });
    const db = await Lead.findById(lead._id).lean();
    expect(`${r.status} converted=${db.converted}`).toBe("400 converted=false");
  });
  test("[-] amount 100000001 -> 400 'treatment_amount is unrealistically large'", async () => {
    const { r } = await convert({ treatment_name: "Root canal", treatment_amount: 100000001 });
    expect(`${r.status} ${r.body.message}`).toBe("400 treatment_amount is unrealistically large");
  });
  test.each([["future", () => new Date(Date.now() + 86400000).toISOString()], ["'abc'", () => "abc"]])(
    "[-] converted_at %s -> 400 'converted_at must be a valid date that is not in the future'",
    async (l, d) => {
      const { r } = await convert({ treatment_name: "Root canal", treatment_amount: 10, converted_at: d() });
      expect(`${r.status} ${r.body.message}`).toBe("400 converted_at must be a valid date that is not in the future");
    }
  );
  test("[-] double convert -> 409 'This lead has already been converted'", async () => {
    const { lead, r } = await convert({ treatment_name: "Root canal", treatment_amount: 10 });
    expect(r.status).toBe(201);
    const again = await client(admin).post(`/api/leads/${lead._id}/convert`, { treatment_name: "Root canal", treatment_amount: 10 });
    expect(`${again.status} ${again.body.message}`).toBe("409 This lead has already been converted");
  });
  test("[-] 3 PARALLEL converts -> one 201, rest 409; exactly 1 Client + 1 LeadConversion", async () => {
    const lead = await newLead();
    const clientsBefore = await Client.countDocuments({ tenant_id: A.tenantId });
    const rs = await Promise.all([1, 2, 3].map(() => client(admin).post(`/api/leads/${lead._id}/convert`, { treatment_name: "Root canal", treatment_amount: 10 })));
    const clients = (await Client.countDocuments({ tenant_id: A.tenantId })) - clientsBefore;
    const convs = await LeadConversion.countDocuments({ lead: lead._id });
    expect(`${rs.map((r) => r.status).sort().join(",")} clients=${clients} conversions=${convs}`).toBe("201,409,409 clients=1 conversions=1");
  });
  test("[-] convert a lead whose name equals an existing customer's company -> reuse/4xx, never 500", async () => {
    await Client.create({ company: "Collide Co", tenant_id: A.tenantId });
    const lead = await newLead({ name: "Collide Co" });
    const r = await client(admin).post(`/api/leads/${lead._id}/convert`, { treatment_name: "Root canal", treatment_amount: 10 });
    expect(r.status).toBeLessThan(500);
  });
});

describe("Convert lead (legacy, patient_conversion OFF)", () => {
  test("[-] 3 PARALLEL converts -> one 201, rest 409; exactly 1 Client", async () => {
    const lead = await newLead();
    const clientsBefore = await Client.countDocuments({ tenant_id: A.tenantId });
    const rs = await Promise.all([1, 2, 3].map(() => client(admin).post(`/api/leads/${lead._id}/convert`, {})));
    const clients = (await Client.countDocuments({ tenant_id: A.tenantId })) - clientsBefore;
    expect(`${rs.map((r) => r.status).sort().join(",")} clients=${clients}`).toBe("201,409,409 clients=1");
  });
});

// ======================================================================================
describe("Delete lead — related records", () => {
  test("[-] DELETE lead with notes, reminders, tasks, files, custom-field values -> none left orphaned", async () => {
    const api = client(admin);
    const c = await api.post("/api/leads", basePayload());
    const id = c.body._id;
    await api.post("/api/notes", { rel_id: id, rel_type: "lead", description: "n1" });
    await api.post("/api/reminders", { rel_id: id, rel_type: "lead", description: "r1", date: new Date(Date.now() + 86400000).toISOString() });
    await api.post("/api/tasks", { name: "t1", related_to: "lead", rel_id: id });
    const up = await uploadFile(admin, id, "leadsneg-orphan.txt", "hello", "text/plain");
    expect(up.status).toBe(201);
    const del = await api.del(`/api/leads/${id}`);
    expect(del.status).toBe(200);
    const left = {
      notes: await Note.countDocuments({ rel_id: id }),
      reminders: await Reminder.countDocuments({ rel_id: id }),
      tasks: await Task.countDocuments({ rel_id: id }),
      files: await File.countDocuments({ rel_id: id }),
      fileOnDisk: fs.existsSync(path.join(UPLOAD_DIR, up.body[0].attachment_key)),
      customFieldValues: await CustomFieldValue.countDocuments({ relid: id }),
    };
    expect(left).toEqual({ notes: 0, reminders: 0, tasks: 0, files: 0, fileOnDisk: false, customFieldValues: 0 });
  });
  test("[-] DELETE a converted lead (has LeadConversion) -> 409, so treatment revenue never points at a missing lead", async () => {
    await setFeatures(A.tenantId, ["patient_conversion"]);
    const lead = await newLead();
    const cv = await client(admin).post(`/api/leads/${lead._id}/convert`, { treatment_name: "Root canal", treatment_amount: 10 });
    await setFeatures(A.tenantId, []);
    expect(cv.status).toBe(201);
    const del = await client(admin).del(`/api/leads/${lead._id}`);
    const orphanConv = (await LeadConversion.countDocuments({ lead: lead._id })) > 0 && !(await Lead.exists({ _id: lead._id }));
    expect(`${del.status} orphanConversion=${orphanConv}`).toMatch(/^409 orphanConversion=false$/);
  });
});

// ======================================================================================
describe("Import (POST /api/leads/import)", () => {
  const imp = (body) => client(admin).post("/api/leads/import", body);
  test.each([["[]", []], ["{leads: []}", { leads: [] }], ["{}", {}]])("[-] %s -> 400 'No valid lead data provided'", async (l, body) => {
    const r = await imp(body);
    expect(`${r.status} ${r.body.message}`).toBe("400 No valid lead data provided");
  });
  test("[-] row without a name -> row rejected/skipped with 4xx or 2xx report, never 500", async () => {
    const r = await imp([{ email: "noname@example.com" }]);
    expect(r.status).toBeLessThan(500);
    expect(await Lead.countDocuments({ tenant_id: A.tenantId, email: "noname@example.com", name: { $in: [null, ""] } })).toBe(0);
  });
  test.each([["'a(b'", "a(b"], ["'*'", "*"], ["'[x'", "[x"]])("[-] name %s (regex metachar) -> imported, never 500", async (l, name) => {
    const r = await imp([{ name, email: `${Date.now()}${Math.random()}@meta.example.com` }]);
    expect(r.status).toBe(201);
  });
  test("[-] name '.*' is imported (not treated as a duplicate of every existing lead)", async () => {
    const r = await imp([{ name: ".*", email: "dotstar@example.com" }]);
    expect(`${r.status} count=${r.body.count}`).toBe("201 count=1");
  });
  test("[-] same email twice INSIDE one file -> 1 imported, 1 skipped", async () => {
    const r = await imp([{ name: uniqName(), email: "infile.dup@example.com" }, { name: uniqName(), email: "infile.dup@example.com" }]);
    expect(await Lead.countDocuments({ tenant_id: A.tenantId, email: "infile.dup@example.com" })).toBe(1);
    expect(r.body.skipped).toBe(1);
  });
  test("[-] duplicate NAME with a different email -> imported (same rule as create, which allows it)", async () => {
    const r = await imp([{ name: "Lead A01", email: "different.person@example.com" }]);
    expect(`${r.status} count=${r.body.count}`).toBe("201 count=1");
  });
  test("[-] status = Tenant B's status id -> dropped (not stored as a cross-tenant ref)", async () => {
    const name = uniqName();
    await imp([{ name, status: String(B.statuses.New), source: String(B.sources.Website) }]);
    const db = await Lead.findOne({ name, tenant_id: A.tenantId }).lean();
    expect({ status: db && db.status ? String(db.status) : null, source: db && db.source ? String(db.source) : null })
      .toEqual({ status: null, source: null });
  });
  test("[~] 5,000 rows -> 201, all 5000 imported in < 30 s", async () => {
    const run = Date.now();
    const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Bulk ${run} ${i}`, email: `bulk${i}.${run}@example.com`, phonenumber: `98${String(10000000 + i)}`, status: "New", source: "Website" }));
    const t0 = Date.now();
    const r = await imp(rows);
    const ms = Date.now() - t0;
    console.info(`[leads.negative] import 5000 rows: HTTP ${r.status} count=${r.body && r.body.count} in ${ms} ms`);
    expect(`${r.status} count=${r.body && r.body.count}`).toBe("201 count=5000");
    expect(ms).toBeLessThan(30000);
  });
});

// ======================================================================================
describe("Meta webhook /api/webhooks/meta-leads", () => {
  const api = client(null);
  const leadgenBody = (leadgenId, pageId = "PAGE_A_TEST") => ({
    object: "page",
    entry: [{ id: pageId, time: 1, changes: [{ field: "leadgen", value: { leadgen_id: leadgenId, page_id: pageId, form_id: "FORM_A1" } }] }],
  });
  afterEach(() => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    graph.handler = null;
  });

  test("[-] GET wrong verify token -> 403", async () => {
    const r = await api.get("/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123");
    expect(r.status).toBe(403);
  });
  test("[-] GET with META_WEBHOOK_VERIFY_TOKEN unset: hard-coded 'rudraverse_crm_2026' must NOT verify (403)", async () => {
    const r = await api.get("/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=rudraverse_crm_2026&hub.challenge=123");
    expect(r.status).toBe(403);
  });
  test("[+] GET with env token set: old default is refused, env token works", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "env-verify-secret";
    expect((await api.get("/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=rudraverse_crm_2026&hub.challenge=1")).status).toBe(403);
    const ok = await api.get("/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=env-verify-secret&hub.challenge=777");
    expect(`${ok.status} ${ok.text}`).toBe("200 777");
  });
  test.each([["no X-Hub-Signature-256", {}], ["wrong X-Hub-Signature-256", { "X-Hub-Signature-256": "sha256=deadbeef" }]])(
    "[-] POST %s -> 401/403, no Graph call, no lead",
    async (l, headers) => {
      const id = `LG_NOSIG_${Date.now()}_${Math.random()}`;
      const graphBefore = guard.graphCalls.length;
      const r = await api.post("/api/webhooks/meta-leads", leadgenBody(id), headers);
      const leads = await Lead.countDocuments({ meta_leadgen_id: id });
      expect(`${r.status} graphCalls=${guard.graphCalls.length - graphBefore} leads=${leads}`).toMatch(/^40[13] graphCalls=0 leads=0$/);
    }
  );
  test("[-] POST for an UNKNOWN page_id (env META_PAGE_ACCESS_TOKEN set) -> no lead in any tenant (esp. hard-coded 6a644ea6…)", async () => {
    process.env.META_PAGE_ACCESS_TOKEN = "env-fallback-page-token";
    const id = `LG_UNKNOWN_${Date.now()}`;
    await api.post("/api/webhooks/meta-leads", leadgenBody(id, "PAGE_NOBODY_OWNS"));
    const landed = await Lead.find({ meta_leadgen_id: id }).select("tenant_id").lean();
    expect(landed.map((l) => String(l.tenant_id))).toEqual([]); // currently lands in HARDCODED_TENANT
    expect(await Lead.countDocuments({ tenant_id: HARDCODED_TENANT })).toBe(0);
  });
  test("[+] POST for unknown page_id with NO env token -> 200, no lead", async () => {
    const id = `LG_UNKNOWN2_${Date.now()}`;
    const r = await api.post("/api/webhooks/meta-leads", leadgenBody(id, "PAGE_NOBODY_OWNS"));
    expect(r.status).toBe(200);
    expect(await Lead.countDocuments({ meta_leadgen_id: id })).toBe(0);
  });
  test.each([["entry missing", { object: "page" }], ["entry not an array", { object: "page", entry: { a: 1 } }], ["entry = 'x'", { object: "page", entry: 5 }]])(
    "[-] POST %s -> 400 (or 200 ignored), never 500",
    async (l, body) => {
      const r = await api.post("/api/webhooks/meta-leads", body);
      expect(r.status).toBeLessThan(500);
    }
  );
  test("[+] POST object !== 'page' -> 404", async () => {
    expect((await api.post("/api/webhooks/meta-leads", { object: "user", entry: [] })).status).toBe(404);
  });
  test("[-] webhook must not write lead PII (email / phone / name) to console logs", async () => {
    const from = logs.length;
    const id = `LG_PII_${Date.now()}`;
    await api.post("/api/webhooks/meta-leads", leadgenBody(id));
    const leaked = logs.slice(from).filter((s) => /meta\.fake@lead\.test|9812345678|Meta Fake Lead/.test(s));
    expect(leaked.map((s) => s.slice(0, 80))).toEqual([]);
  });
});

// ======================================================================================
describe("Public website form POST /api/public/website-leads/:key", () => {
  const api = client(null);
  const post = (body, key = A.websiteForm.key) => api.post(`/api/public/website-leads/${key}`, body);
  const leadCount = () => Lead.countDocuments({ tenant_id: A.tenantId });
  const fieldCount = () => CustomField.countDocuments({ tenant_id: A.tenantId });

  test("[+] unknown key -> 404 'Unknown form'", async () => {
    const r = await post({ name: "x" }, "no-such-key");
    expect(`${r.status} ${r.body.message}`).toBe("404 Unknown form");
  });
  test("[+] deleted form's key -> 404", async () => {
    const f = await WebsiteLeadForm.create({ tenant_id: A.tenantId, name: "Temp form" });
    await WebsiteLeadForm.deleteOne({ _id: f._id });
    expect((await post({ name: "x" }, f.key)).status).toBe(404);
  });
  test("[-] empty body (no fields) -> 400, no 'Website Lead' created", async () => {
    const before = await leadCount();
    const r = await post({});
    expect(`${r.status} saved=${(await leadCount()) - before}`).toMatch(/^4\d\d saved=0$/);
  });
  test("[-] name 100 KB -> 4xx, nothing saved", async () => {
    const before = await leadCount();
    const r = await post({ name: N(100 * 1024), email: "big@example.com" });
    expect(`${r.status} saved=${(await leadCount()) - before}`).toMatch(/^4\d\d saved=0$/);
  });
  test("[-] email 'abc' -> 400, nothing saved", async () => {
    const before = await leadCount();
    const r = await post({ name: "Bad Email", email: "abc" });
    expect(`${r.status} saved=${(await leadCount()) - before}`).toMatch(/^4\d\d saved=0$/);
  });
  test("[-] 500 extra keys in one post -> 4xx, or at most 20 custom fields auto-created", async () => {
    const before = await fieldCount();
    const body = { name: "Many Keys", email: "many@example.com" };
    for (let i = 0; i < 500; i++) body[`extra_key_${i}`] = `v${i}`;
    const r = await post(body);
    const gained = (await fieldCount()) - before;
    expect(`status=${r.status} gained=${gained}`).toMatch(/^status=(4\d\d gained=0|201 gained=([0-9]|1[0-9]|20))$/);
  });
  test("[-] keys '__proto__' / '$where' / 'a.b' -> no 500, no prototype pollution", async () => {
    const r = await post('{"name":"Proto Test","__proto__":{"polluted":"yes"},"$where":"sleep(1000)","a.b":"dotted","constructor":{"prototype":{"polluted2":"yes"}}}');
    expect(r.status).toBeLessThan(500);
    expect({}.polluted).toBeUndefined();
    expect({}.polluted2).toBeUndefined();
  });
  test("[-] the same email submitted twice -> only one lead (duplicate check)", async () => {
    const email = `twice.${Date.now()}@example.com`;
    await post({ name: "Twice", email });
    await post({ name: "Twice", email });
    expect(await Lead.countDocuments({ tenant_id: A.tenantId, email })).toBe(1);
  });

  describe("50 rapid anonymous posts with random extra keys", () => {
    let statuses = [], gained = 0;
    beforeAll(async () => {
      const before = await fieldCount();
      const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
        post({ name: `Burst ${i}`, email: `burst${i}@example.com`, [`rnd_${i}_${Math.random().toString(36).slice(2, 8)}`]: "x" })));
      statuses = rs.map((r) => r.status);
      gained = (await fieldCount()) - before;
      console.info(`[leads.negative] 50 public posts: statuses=${[...new Set(statuses)]} customFieldsGained=${gained}`);
    });
    test("[-] rate limit: at least one request is throttled (429)", () => {
      expect(statuses).toContain(429);
    });
    test("[-] anonymous posts cannot grow the tenant's custom-field schema without bound (<= 20 new fields)", () => {
      expect(gained).toBeLessThanOrEqual(20);
    });
  });

  test("[i] CODE-READING: real CORS for /api/public/website-leads is origin:* (reflect any origin), credentials:false (index.js:53-56)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../index.js"), "utf8");
    expect(src).toMatch(/req\.path\.startsWith\("\/api\/public\/website-leads"\)[\s\S]{0,80}origin: true, credentials: false/);
  });
});

test("guard: Graph API was only ever the fake; no real Facebook call", () => {
  expect(guard.realFacebookCalls).toBe(0);
  expect(guard.blockedExternal.filter((h) => /facebook/i.test(h))).toEqual([]);
});
