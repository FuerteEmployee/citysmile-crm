// Customers module — INTEGRATION tests: every endpoint, permissions (view-only / no-access),
// tenant isolation A vs B, delete-with-invoices, statement maths. In-memory MongoDB only.
jest.setTimeout(120000);
// Vault passwords are encrypted with this key (utils/secretBox); test-only value.
process.env.INTEGRATION_ENCRYPTION_KEY = "customers-test-encryption-key-123";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

let baseUrl, A, B, Client, Contact, ClientGroup, VaultEntry, FileM, Reminder, Invoice, Payment, Note;
const uploadedKeys = [];
const UPLOAD_DIR = path.join(__dirname, "../../uploads");

const uploadFile = async (token, clientId, name = "a.txt", content = "hello", type = "text/plain") => {
  const fd = new FormData();
  fd.append("files", new Blob([content], { type }), name);
  const res = await fetch(`${baseUrl}/api/clients/${clientId}/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = await res.json().catch(() => null);
  if (Array.isArray(body)) body.forEach((f) => f.attachment_key && uploadedKeys.push(f.attachment_key));
  return { status: res.status, body };
};

beforeAll(async () => {
  ({ baseUrl } = await start([
    ["/api/clients", "routes/client_routes"],
    ["/api/client-groups", "routes/client_group_routes"],
    ["/api/notes", "routes/note_routes"],
  ]));
  Client = require("../../models/Client");
  Contact = require("../../models/Contact");
  ClientGroup = require("../../models/ClientGroup");
  VaultEntry = require("../../models/VaultEntry");
  FileM = require("../../models/File");
  Reminder = require("../../models/Reminder");
  Invoice = require("../../models/Invoice");
  Payment = require("../../models/Payment");
  Note = require("../../models/Note");
  A = await seedCompany("A", ["Customers"]);
  B = await seedCompany("B", ["Customers"]);
});
afterAll(async () => {
  for (const k of uploadedKeys) { try { fs.unlinkSync(path.join(UPLOAD_DIR, k)); } catch { /* gone */ } }
  await stop();
});

// ---------------------------------------------------------------- permissions
describe("Permissions — VIEW-ONLY user must get 403 on every write", () => {
  let cid, contactId, groupId, view;
  beforeAll(async () => {
    const admin = client(A.admin.token);
    cid = (await admin.post("/api/clients", { company: "Perm Target" })).body._id;
    contactId = (await admin.post(`/api/clients/${cid}/contacts`, { firstname: "P", lastname: "T", email: "perm@x.com" })).body._id;
    groupId = (await admin.post("/api/client-groups", { name: "PermGroup" })).body._id;
    view = client(A.viewOnly.token);
  });

  test("[perm] view-only CAN read the list and a record", async () => {
    expect((await view.get("/api/clients")).status).toBe(200);
    expect((await view.get(`/api/clients/${cid}`)).status).toBe(200);
  });
  test.each([
    ["POST /api/clients", (v, id) => v.post("/api/clients", { company: "ViewOnly Made This" })],
    ["PUT /api/clients/:id", (v, id) => v.put(`/api/clients/${id}`, { company: "Perm Target", city: "changed by viewer" })],
    ["POST /api/clients/import", (v) => v.post("/api/clients/import", [{ "Company Name": "Viewer Import" }])],
    ["POST /api/clients/:id/contacts", (v, id) => v.post(`/api/clients/${id}/contacts`, { firstname: "v", lastname: "v", email: "v@x.com" })],
    ["POST /api/clients/:id/vault", (v, id) => v.post(`/api/clients/${id}/vault`, { server: "s", username: "u", password: "p" })],
    ["POST /api/clients/:id/reminders", (v, id) => v.post(`/api/clients/${id}/reminders`, { description: "x", date: "2026-12-01" })],
    ["POST /api/clients/transfer-or-assign", (v, id) => v.post("/api/clients/transfer-or-assign", { toStaffId: String(A.viewOnly.id), clientIds: [id], sync: false })],
    ["POST /api/clients/contacts/import", (v) => v.post("/api/clients/contacts/import", [{ company: "Perm Target", firstname: "i", email: "imp.v@x.com" }])],
    ["POST /api/client-groups", (v) => v.post("/api/client-groups", { name: "Viewer group" })],
    ["POST /api/client-groups/bulk", (v) => v.post("/api/client-groups/bulk", { groups: ["Viewer bulk"] })],
  ])("[perm] view-only %s -> 403", async (label, fn) => {
    const r = await fn(view, cid);
    expect(`${label} -> ${r.status}`).toBe(`${label} -> 403`);
  });
  test("[perm] view-only POST /:id/files -> 403", async () => {
    const r = await uploadFile(A.viewOnly.token, cid);
    expect(r.status).toBe(403);
  });
  test("[perm] view-only PUT /api/clients/contacts/:id -> 403", async () => {
    expect((await view.put(`/api/clients/contacts/${contactId}`, { title: "hacked" })).status).toBe(403);
  });
  test("[perm] view-only PUT /api/client-groups/:id -> 403", async () => {
    expect((await view.put(`/api/client-groups/${groupId}`, { name: "renamed by viewer" })).status).toBe(403);
  });
  test("[perm] view-only DELETE /api/clients/contacts/:id -> 403", async () => {
    expect((await view.del(`/api/clients/contacts/${contactId}`)).status).toBe(403);
  });
  test("[perm] view-only DELETE /api/client-groups/:id -> 403", async () => {
    expect((await view.del(`/api/client-groups/${groupId}`)).status).toBe(403);
  });
  test("[perm] view-only POST /bulk-delete -> 403", async () => {
    const victim = (await client(A.admin.token).post("/api/clients", { company: "Bulk victim" })).body._id;
    const r = await view.post("/api/clients/bulk-delete", { ids: [victim] });
    expect(r.status).toBe(403);
  });
  test("[perm] view-only DELETE /api/clients/:id -> 403", async () => {
    const victim = (await client(A.admin.token).post("/api/clients", { company: "Delete victim" })).body._id;
    const r = await view.del(`/api/clients/${victim}`);
    expect(r.status).toBe(403);
  });
  test("[perm] no-access user -> 403 on clients and client-groups", async () => {
    const n = client(A.noAccess.token);
    expect((await n.get("/api/clients")).status).toBe(403);
    expect((await n.get("/api/client-groups")).status).toBe(403);
  });
  test("[perm] client-groups lowercase 'view/create/edit/delete': full-access staff is NOT wrongly 403'd", async () => {
    const f = client(A.full.token);
    expect((await f.get("/api/client-groups")).status).toBe(200);
    const g = await f.post("/api/client-groups", { name: "FullUserGroup" });
    expect(g.status).toBe(201);
    expect((await f.put(`/api/client-groups/${g.body._id}`, { name: "FullUserGroup2" })).status).toBe(200);
    expect((await f.del(`/api/client-groups/${g.body._id}`)).status).toBe(200);
  });
  test("[perm] full-access staff can create/edit/delete customers", async () => {
    const f = client(A.full.token);
    const c = await f.post("/api/clients", { company: "Full user co" });
    expect(c.status).toBe(201);
    expect((await f.put(`/api/clients/${c.body._id}`, { company: "Full user co 2" })).status).toBe(200);
    expect((await f.del(`/api/clients/${c.body._id}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- tenant isolation
describe("Tenant isolation — Tenant A must never read/edit/delete Tenant B data", () => {
  let a, bAdmin, bCid, bContact, bFile, bVault, bReminder, bGroup, bNote;
  beforeAll(async () => {
    a = client(A.admin.token);
    bAdmin = client(B.admin.token);
    bCid = (await bAdmin.post("/api/clients", { company: "B Secret Co", email: "secret@b.com" })).body._id;
    bContact = (await bAdmin.post(`/api/clients/${bCid}/contacts`, { firstname: "Bob", lastname: "B", email: "bob@b.com" })).body._id;
    bFile = (await uploadFile(B.admin.token, bCid, "b-secret.txt", "secret")).body[0]._id;
    bVault = (await bAdmin.post(`/api/clients/${bCid}/vault`, { server: "b.srv", username: "broot", password: "bpass" })).body._id;
    bReminder = (await bAdmin.post(`/api/clients/${bCid}/reminders`, { description: "B reminder", date: "2026-12-01" })).body._id;
    bGroup = (await bAdmin.post("/api/client-groups", { name: "B Group" })).body._id;
    bNote = (await bAdmin.post("/api/notes", { rel_id: bCid, rel_type: "customer", description: "B note" })).body._id;
    await Invoice.create({ client: bCid, number: "B-INV-1", total: 9999, subtotal: 9999, tenant_id: B.tenantId });
  });

  test("[iso] list does not include B customers", async () => {
    const r = await a.get("/api/clients");
    expect(r.body.map((c) => c.company)).not.toContain("B Secret Co");
    expect((await a.get("/api/clients?search=Secret&page=1")).body.total).toBe(0);
  });
  test("[iso] GET B customer -> 404", async () => {
    expect((await a.get(`/api/clients/${bCid}`)).status).toBe(404);
  });
  test("[iso] PUT B customer -> 403/404 and B unchanged", async () => {
    const r = await a.put(`/api/clients/${bCid}`, { company: "Hijacked by A" });
    const db = await Client.findById(bCid).lean();
    expect(`${r.status} company=${db.company}`).toMatch(/^40[34] company=B Secret Co$/);
  });
  test("[iso] GET B customer's contacts -> 403/404 / empty", async () => {
    const r = await a.get(`/api/clients/${bCid}/contacts`);
    expect(r.status === 404 || r.status === 403 || (Array.isArray(r.body) && r.body.length === 0)).toBe(true);
  });
  test("[iso] contacts/all does not include B contacts", async () => {
    const r = await a.get("/api/clients/contacts/all");
    expect(r.body.map((c) => c.email)).not.toContain("bob@b.com");
    const r2 = await a.get("/api/clients/contacts/all?search=B%20Secret&page=1");
    expect(r2.body.total).toBe(0);
  });
  test("[iso] POST a contact onto B customer -> 403/404", async () => {
    const r = await a.post(`/api/clients/${bCid}/contacts`, { firstname: "Evil", lastname: "A", email: "evil@a.com" });
    expect(r.status).toBeGreaterThanOrEqual(403);
    expect(await Contact.countDocuments({ userid: bCid, email: "evil@a.com" })).toBe(0);
  });
  test("[iso] PUT B contact -> 403/404 and unchanged", async () => {
    const r = await a.put(`/api/clients/contacts/${bContact}`, { firstname: "Hacked" });
    expect(`${r.status} ${(await Contact.findById(bContact)).firstname}`).toMatch(/^40[34] Bob$/);
  });
  test("[iso] GET B files -> 403/404 / empty", async () => {
    const r = await a.get(`/api/clients/${bCid}/files`);
    expect(r.status === 404 || r.status === 403 || (Array.isArray(r.body) && r.body.length === 0)).toBe(true);
  });
  test("[iso] upload a file onto B customer -> 403/404", async () => {
    const r = await uploadFile(A.admin.token, bCid, "a-into-b.txt");
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
  test("[iso] GET B vault -> 404 / empty", async () => {
    const r = await a.get(`/api/clients/${bCid}/vault`);
    expect(r.status === 404 || (Array.isArray(r.body) && r.body.length === 0)).toBe(true);
  });
  test("[iso] POST vault entry onto B customer -> 403/404", async () => {
    const r = await a.post(`/api/clients/${bCid}/vault`, { server: "x", username: "x", password: "x" });
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
  test("[iso] GET B reminders -> 404 / empty", async () => {
    const r = await a.get(`/api/clients/${bCid}/reminders`);
    expect(r.status === 404 || (Array.isArray(r.body) && r.body.length === 0)).toBe(true);
  });
  test("[iso] POST reminder onto B customer -> 403/404", async () => {
    const r = await a.post(`/api/clients/${bCid}/reminders`, { description: "A into B", date: "2026-12-01" });
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
  test("[iso] DELETE B reminder -> 404 and still exists", async () => {
    expect((await a.del(`/api/clients/reminders/${bReminder}`)).status).toBe(404);
    expect(await Reminder.findById(bReminder)).not.toBeNull();
  });
  test("[iso] GET B statement -> 403/404 (must not leak B invoice totals)", async () => {
    const r = await a.get(`/api/clients/${bCid}/statement`);
    expect(`${r.status} totalInvoiced=${r.body && r.body.totalInvoiced}`).toMatch(/^40[34]/);
  });
  test("[iso] GET B notes -> empty", async () => {
    expect((await a.get(`/api/notes?rel_id=${bCid}&rel_type=customer`)).body).toEqual([]);
  });
  test("[iso] PUT B note -> 403/404 and unchanged", async () => {
    const r = await a.put(`/api/notes/${bNote}`, { description: "A edited B note" });
    expect(`${r.status} ${(await Note.findById(bNote)).description}`).toMatch(/^40[34] B note$/);
  });
  test("[iso] client-groups list excludes B groups", async () => {
    expect((await a.get("/api/client-groups")).body.map((g) => g.name)).not.toContain("B Group");
  });
  test("[iso] PUT B client-group -> 403/404 and unchanged", async () => {
    const r = await a.put(`/api/client-groups/${bGroup}`, { name: "Renamed by A" });
    expect(`${r.status} ${(await ClientGroup.findById(bGroup)).name}`).toMatch(/^40[34] B Group$/);
  });
  // Group names are unique per company, so another company's name is free to use.
  test("[iso] same group name as a Tenant B group -> 201 (names are unique per company)", async () => {
    await bAdmin.post("/api/client-groups", { name: "Wholesale" });
    const r = await a.post("/api/client-groups", { name: "Wholesale" });
    expect(r.status).toBe(201);
  });
  test("[iso] bulk-delete with B ids deletes nothing in B", async () => {
    const r = await a.post("/api/clients/bulk-delete", { ids: [bCid] });
    expect(r.body.deletedCount).toBe(0);
    expect(await Client.findById(bCid)).not.toBeNull();
  });
  test("[iso] transfer-or-assign to a B staff -> 404", async () => {
    expect((await a.post("/api/clients/transfer-or-assign", { toStaffId: String(B.full.id), clientIds: [] })).status).toBe(404);
  });
  test("[iso] contacts import: an email existing only in Tenant B must not block import in A", async () => {
    await a.post("/api/clients", { company: "A Importer" });
    const r = await a.post("/api/clients/contacts/import", [{ company: "A Importer", firstname: "Same", email: "bob@b.com" }]);
    expect(r.body.count).toBe(1);
  });

  // Destructive cross-tenant calls last (they may actually delete B data if the bug exists).
  test("[iso] DELETE B contact -> 403/404 and still exists", async () => {
    await a.del(`/api/clients/contacts/${bContact}`);
    expect(await Contact.findById(bContact)).not.toBeNull();
  });
  test("[iso] DELETE B file -> 403/404 and still exists", async () => {
    await a.del(`/api/clients/${bCid}/files/${bFile}`);
    expect(await FileM.findById(bFile)).not.toBeNull();
  });
  test("[iso] DELETE B vault entry -> 403/404 and still exists", async () => {
    await a.del(`/api/clients/vault/${bVault}`);
    expect(await VaultEntry.findById(bVault)).not.toBeNull();
  });
  test("[iso] DELETE B note -> 403/404 and still exists", async () => {
    await a.del(`/api/notes/${bNote}`);
    expect(await Note.findById(bNote)).not.toBeNull();
  });
  test("[iso] DELETE B client-group -> 403/404 and still exists", async () => {
    await a.del(`/api/client-groups/${bGroup}`);
    expect(await ClientGroup.findById(bGroup)).not.toBeNull();
  });
  test("[iso] DELETE B customer -> 403/404 and still exists", async () => {
    const r = await a.del(`/api/clients/${bCid}`);
    expect(`${r.status} exists=${!!(await Client.findById(bCid))}`).toMatch(/^40[34] exists=true$/);
  });
});

// ---------------------------------------------------------------- sensitive data handling
describe("Sensitive data", () => {
  test("[sec] vault password is not stored in plain text, and reads back decrypted", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Vault Co" })).body._id;
    const v = await a.post(`/api/clients/${cid}/vault`, { server: "s", username: "u", password: "PlainPass123" });
    const raw = await mongoose.connection.db.collection("vaultentries").findOne({ _id: new mongoose.Types.ObjectId(v.body._id) });
    expect(raw.password).not.toBe("PlainPass123");
    expect((await a.get(`/api/clients/${cid}/vault`)).body[0].password).toBe("PlainPass123");
    // a legacy plain-text row still reads correctly
    await mongoose.connection.db.collection("vaultentries").insertOne({ client: new mongoose.Types.ObjectId(cid), server: "old", username: "u", password: "legacyPlain", tenant_id: A.tenantId });
    expect((await a.get(`/api/clients/${cid}/vault`)).body.map((v) => v.password)).toContain("legacyPlain");
  });
  test("[sec] contact password set through PUT /contacts/:id is hashed, and never returned", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Pwd Co" })).body._id;
    const c = await a.post(`/api/clients/${cid}/contacts`, { firstname: "P", lastname: "W", email: "pw@x.com" });
    const u = await a.put(`/api/clients/contacts/${c.body._id}`, { password: "Secret#1" });
    const raw = await mongoose.connection.db.collection("contacts").findOne({ _id: new mongoose.Types.ObjectId(c.body._id) });
    expect(raw.password).not.toBe("Secret#1");
    expect(u.body.password).toBeUndefined();
  });
});

// ---------------------------------------------------------------- cascade / invoices / statement
describe("Delete with related data + statement", () => {
  test("[int] deleting a customer that has invoices is blocked (409) — no orphaned invoices", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Has Invoices" })).body._id;
    await Invoice.create({ client: cid, number: "A-INV-ORPH", total: 100, subtotal: 100, tenant_id: A.tenantId });
    const r = await a.del(`/api/clients/${cid}`);
    const orphan = (await Invoice.countDocuments({ client: cid })) > 0 && !(await Client.findById(cid));
    expect(`${r.status} orphanedInvoices=${orphan}`).toMatch(/^(409|400) orphanedInvoices=false$/);
  });
  test("[int] deleting a customer also removes its files, vault entries, reminders, notes", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Cascade Co" })).body._id;
    await uploadFile(A.admin.token, cid, "c.txt");
    await a.post(`/api/clients/${cid}/vault`, { server: "s", username: "u", password: "p" });
    await a.post(`/api/clients/${cid}/reminders`, { description: "r", date: "2026-12-01" });
    await a.post("/api/notes", { rel_id: cid, rel_type: "customer", description: "n" });
    await a.del(`/api/clients/${cid}`);
    const left = {
      files: await FileM.countDocuments({ rel_id: cid }),
      vault: await VaultEntry.countDocuments({ client: cid }),
      reminders: await Reminder.countDocuments({ rel_id: cid }),
      notes: await Note.countDocuments({ rel_id: cid }),
    };
    expect(left).toEqual({ files: 0, vault: 0, reminders: 0, notes: 0 });
  });
  test("[int] deleting a customer removes it from list and its contacts", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Gone Co" })).body._id;
    await a.post(`/api/clients/${cid}/contacts`, { firstname: "g", lastname: "g", email: "gone@x.com" });
    await a.del(`/api/clients/${cid}`);
    expect((await a.get(`/api/clients/${cid}`)).status).toBe(404);
    expect(await Contact.countDocuments({ userid: cid })).toBe(0);
  });
  test("[int] statement: invoice total - payments = balance; from/to range and opening balance", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Statement Co" })).body._id;
    const i1 = await Invoice.create({ client: cid, number: "ST-1", total: 1000, subtotal: 1000, tenant_id: A.tenantId, date: new Date("2025-12-15") });
    const i2 = await Invoice.create({ client: cid, number: "ST-2", total: 2500, subtotal: 2500, tenant_id: A.tenantId, date: new Date("2026-02-01") });
    await Payment.create({ invoice: i1._id, amount: 400, date: new Date("2025-12-20") });
    await Payment.create({ invoice: i2._id, amount: 1000, date: new Date("2026-02-10") });
    const r = await a.get(`/api/clients/${cid}/statement?from=2026-01-01&to=2026-12-31`);
    expect(r.status).toBe(200);
    expect(r.body.beginningBalance).toBe(600);
    expect(r.body.totalInvoiced).toBe(2500);
    expect(r.body.totalPaid).toBe(1000);
    expect(r.body.balanceDue).toBe(600 + 2500 - 1000);
    expect(r.body.entries.map((e) => e.balance)).toEqual([3100, 2100]);
  });
  test("[int] statement 'to' date includes invoices dated later that same day", async () => {
    const a = client(A.admin.token);
    const cid = (await a.post("/api/clients", { company: "Statement Day Co" })).body._id;
    await Invoice.create({ client: cid, number: "ST-DAY", total: 50, subtotal: 50, tenant_id: A.tenantId, date: new Date("2026-03-31T15:00:00Z") });
    const r = await a.get(`/api/clients/${cid}/statement?from=2026-03-01&to=2026-03-31`);
    expect(r.body.totalInvoiced).toBe(50);
  });
});
