// Customers module — POSITIVE API tests (valid data must work; API response and DB must match).
// In-memory MongoDB only. Uploaded test files are removed from src/uploads in afterAll.
jest.setTimeout(120000);

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { start, stop, seedCompany, client } = require("../../testUtils/crmTestApp");

let baseUrl, A, api, Client, Contact, HRMSBranch;
const uploadedKeys = [];
const UPLOAD_DIR = path.join(__dirname, "../../uploads");

const uploadFile = async (token, clientId, name, content, type = "text/plain") => {
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
  HRMSBranch = require("../../hrms/models/hrms_branch_model");
  A = await seedCompany("A", ["Customers"]);
  api = client(A.admin.token);
  // Currency must exist in the company (the form sends the currency name).
  await mongoose.connection.db.collection("currencies").insertOne({ name: "INR", symbol: "₹", tenant_id: A.tenantId });
});
afterAll(async () => {
  for (const k of uploadedKeys) { try { fs.unlinkSync(path.join(UPLOAD_DIR, k)); } catch { /* already removed */ } }
  await stop();
});

const FULL = () => ({
  company: "Full Fields Pvt Ltd",
  customer_reference: "CUST-1001",
  contact_person: "John Doe",
  vat: "VAT123",
  phonenumber: "9876543210",
  email: "john@fullfields.com",
  website: "https://fullfields.com",
  pan_number: "ABCDE1234F",
  gst_number: "27ABCDE1234F1Z5",
  account_details: "Bank of India - 1234567890",
  currency: "INR",
  default_language: "English",
  address: "123 MG Road",
  city: "Mumbai",
  state: "Maharashtra",
  zip: "400001",
  country: "India",
  billing_street: "1 Bill St", billing_city: "Pune", billing_state: "MH", billing_zip: "411001", billing_country: "India",
  shipping_street: "2 Ship St", shipping_city: "Surat", shipping_state: "GJ", shipping_zip: "395001", shipping_country: "India",
  active: true,
});

describe("Create / edit / delete", () => {
  test("[+] create with only Company", async () => {
    const r = await api.post("/api/clients", { company: "Only Company" });
    expect(r.status).toBe(201);
    const db = await Client.findById(r.body._id).lean();
    expect(db.company).toBe("Only Company");
    expect(db.active).toBe(true);
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });

  test("[+] create with ALL fields filled — every field saved", async () => {
    const branch = await HRMSBranch.create({ name: "Mumbai Branch", tenant_id: A.tenantId });
    const g = await api.post("/api/client-groups", { name: "Gold" });
    expect(g.status).toBe(201);
    const payload = { ...FULL(), branch: String(branch._id), sales_person: String(A.full.id), groups: [g.body._id] };
    const r = await api.post("/api/clients", payload);
    expect(r.status).toBe(201);
    const db = await Client.findById(r.body._id).lean();
    for (const [k, v] of Object.entries(FULL())) expect([k, db[k]]).toEqual([k, v]);
    expect(String(db.branch)).toBe(String(branch._id));
    expect(String(db.sales_person)).toBe(String(A.full.id));
    expect(db.groups.map(String)).toEqual([g.body._id]);
    expect(db.phoneE164).toBe("+919876543210");
  });

  test("[+] GET /:id returns populated record", async () => {
    // (a second customer, so a different name — duplicate names are now 409)
    const c = await api.post("/api/clients", { ...FULL(), company: "Full Fields Two", customer_reference: "CUST-1002" });
    const r = await api.get(`/api/clients/${c.body._id}`);
    expect(r.status).toBe(200);
    expect(r.body.company).toBe("Full Fields Two");
    expect(r.body.custom_fields).toBeDefined();
  });

  test("[+] edit every field and save", async () => {
    const c = await api.post("/api/clients", { company: "Edit Me" });
    const edited = {
      ...FULL(), company: "Edited Co", customer_reference: "CUST-2", contact_person: "Jane", vat: "V2",
      phonenumber: "+91 91234-56789", email: "jane@edited.com", website: "https://edited.com", city: "Delhi",
      billing_city: "Noida", shipping_city: "Agra",
    };
    const r = await api.put(`/api/clients/${c.body._id}`, edited);
    expect(r.status).toBe(200);
    const db = await Client.findById(c.body._id).lean();
    for (const [k, v] of Object.entries(edited)) expect([k, db[k]]).toEqual([k, v]);
    expect(db.phoneE164).toBe("+919123456789");
  });

  test("[+] toggle Active -> Inactive -> Active", async () => {
    const c = await api.post("/api/clients", { company: "Toggle Co" });
    await api.put(`/api/clients/${c.body._id}`, { company: "Toggle Co", active: false });
    expect((await Client.findById(c.body._id)).active).toBe(false);
    await api.put(`/api/clients/${c.body._id}`, { company: "Toggle Co", active: true });
    expect((await Client.findById(c.body._id)).active).toBe(true);
  });

  test("[+] partial PUT (only active) keeps the other fields (branch / sales person)", async () => {
    const branch = await HRMSBranch.create({ name: "Keep Branch", tenant_id: A.tenantId });
    const c = await api.post("/api/clients", { company: "Keep Co", branch: String(branch._id), sales_person: String(A.full.id) });
    await api.put(`/api/clients/${c.body._id}`, { active: false });
    const db = await Client.findById(c.body._id);
    expect(String(db.branch)).toBe(String(branch._id));
    expect(String(db.sales_person)).toBe(String(A.full.id));
  });

  test("[+] delete", async () => {
    const c = await api.post("/api/clients", { company: "Delete Co" });
    const r = await api.del(`/api/clients/${c.body._id}`);
    expect(r.status).toBe(200);
    expect(await Client.findById(c.body._id)).toBeNull();
  });
});

describe("List: search, filters, page size", () => {
  let T, t;
  beforeAll(async () => {
    T = await seedCompany("List", ["Customers"]);
    t = client(T.admin.token);
    for (let i = 1; i <= 12; i++) await t.post("/api/clients", { company: `Row ${i}`, active: i <= 8, email: `r${i}@x.com` });
  });
  test("[+] search", async () => {
    const r = await t.get("/api/clients?search=Row%201&page=1&limit=25");
    expect(r.body.data.map((c) => c.company).sort()).toEqual(["Row 1", "Row 10", "Row 11", "Row 12"]);
  });
  test("[+] status filter Active / Inactive and counts", async () => {
    expect((await t.get("/api/clients?status=Active&page=1")).body.total).toBe(8);
    expect((await t.get("/api/clients?status=Inactive&page=1")).body.total).toBe(4);
    const all = await t.get("/api/clients?page=1");
    expect([all.body.total, all.body.activeCount, all.body.inactiveCount]).toEqual([12, 8, 4]);
  });
  test("[+] page size 5 -> 3 pages, newest first", async () => {
    const r = await t.get("/api/clients?page=1&limit=5");
    expect(r.body.data.length).toBe(5);
    expect(r.body.pages).toBe(3);
    expect(r.body.data[0].company).toBe("Row 12");
  });
  test("[+] export endpoint (unpaginated GET) returns every row", async () => {
    const r = await t.get("/api/clients");
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(12);
  });
});

describe("Import / assign group / mass delete / transfer", () => {
  test("[+] import a valid 3-row file", async () => {
    const r = await api.post("/api/clients/import", [
      { "Company Name": "Imp A", Email: "a@imp.com", "Phone Number": "9876500001" },
      { "Company Name": "Imp B", Email: "b@imp.com" },
      { "Company Name": "Imp C", "PAN Number": "ABCDE1234F", "GST Number": "27ABCDE1234F1Z5" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.insertedCount).toBe(3);
    const c = await Client.findOne({ tenant_id: A.tenantId, company: "Imp C" }).lean();
    expect(c.pan_number).toBe("ABCDE1234F");
    expect(c.gst_number).toBe("27ABCDE1234F1Z5");
    expect((await Client.findOne({ company: "Imp A" })).email).toBe("a@imp.com");
  });
  test("[+] assign to group (PUT groups)", async () => {
    const g = await api.post("/api/client-groups", { name: "Silver" });
    const c = await api.post("/api/clients", { company: "Group Me" });
    await api.put(`/api/clients/${c.body._id}`, { company: "Group Me", groups: [g.body._id] });
    const r = await api.get(`/api/clients/${c.body._id}`);
    expect(r.body.groups.map((x) => x.name)).toEqual(["Silver"]);
  });
  test("[+] bulk Assign Group ADDS the group and keeps existing groups / branch / sales person", async () => {
    const g1 = await api.post("/api/client-groups", { name: "Keep G1" });
    const g2 = await api.post("/api/client-groups", { name: "Add G2" });
    const c = await api.post("/api/clients", { company: "Bulk Group Co", groups: [g1.body._id], sales_person: String(A.full.id) });
    const r = await api.post("/api/clients/bulk-assign-group", { ids: [c.body._id], groupId: g2.body._id });
    expect(r.status).toBe(200);
    const db = await Client.findById(c.body._id).lean();
    expect(db.groups.map(String).sort()).toEqual([g1.body._id, g2.body._id].sort());
    expect(String(db.sales_person)).toBe(String(A.full.id));
  });
  test("[+] mass delete only the selected rows", async () => {
    const ids = [];
    for (const n of ["MD1", "MD2", "MD3"]) ids.push((await api.post("/api/clients", { company: n })).body._id);
    const r = await api.post("/api/clients/bulk-delete", { ids: ids.slice(0, 2) });
    expect(r.body.deletedCount).toBe(2);
    expect(await Client.findById(ids[2])).not.toBeNull();
  });
  test("[+] transfer-or-assign", async () => {
    const c = await api.post("/api/clients", { company: "Assign Me" });
    const r = await api.post("/api/clients/transfer-or-assign", { toStaffId: String(A.full.id), clientIds: [c.body._id], sync: false });
    expect(r.status).toBe(200);
    expect(String((await Client.findById(c.body._id)).sales_person)).toBe(String(A.full.id));
  });
  test("[+] client groups: list, rename, bulk create, delete", async () => {
    const g = await api.post("/api/client-groups", { name: "Bronze" });
    expect((await api.put(`/api/client-groups/${g.body._id}`, { name: "Bronze 2" })).body.name).toBe("Bronze 2");
    const bulk = await api.post("/api/client-groups/bulk", { groups: ["G1", " G2 ", ""] });
    expect(bulk.status).toBe(201);
    expect(bulk.body.map((x) => x.name)).toEqual(["G1", "G2"]);
    const list = await api.get("/api/client-groups");
    expect(list.body.map((x) => x.name)).toEqual(expect.arrayContaining(["Bronze 2", "G1", "G2"]));
    expect((await api.del(`/api/client-groups/${g.body._id}`)).status).toBe(200);
  });
});

describe("Customer View tabs: contacts, notes, files, vault, reminders, statement", () => {
  let cid;
  beforeAll(async () => { cid = (await api.post("/api/clients", { company: "View Tabs Co" })).body._id; });

  test("[+] every tab endpoint loads (200)", async () => {
    for (const p of [`/api/clients/${cid}`, `/api/clients/${cid}/contacts`, `/api/clients/${cid}/files`, `/api/clients/${cid}/vault`,
      `/api/clients/${cid}/reminders`, `/api/clients/${cid}/statement`, `/api/notes?rel_id=${cid}&rel_type=customer`, "/api/clients/contacts/all"]) {
      expect([p, (await api.get(p)).status]).toEqual([p, 200]);
    }
  });
  test("[+] contact add / edit / delete", async () => {
    const c = await api.post(`/api/clients/${cid}/contacts`, { firstname: "Ann", lastname: "Lee", email: "ANN@x.com", is_primary: true });
    expect(c.status).toBe(201);
    expect(c.body.email).toBe("ann@x.com");
    const u = await api.put(`/api/clients/contacts/${c.body._id}`, { title: "CEO", phonenumber: "9876543211" });
    expect(u.body.title).toBe("CEO");
    const list = await api.get(`/api/clients/${cid}/contacts`);
    expect(list.body.length).toBe(1);
    expect((await api.get(`/api/clients?page=1&search=View%20Tabs`)).body.data[0].primaryContact.firstname).toBe("Ann");
    expect((await api.del(`/api/clients/contacts/${c.body._id}`)).status).toBe(200);
    expect(await Contact.findById(c.body._id)).toBeNull();
  });
  test("[+] contact edit keeps phoneE164 in sync", async () => {
    const c = await api.post(`/api/clients/${cid}/contacts`, { firstname: "Ph", lastname: "One", email: "ph@x.com", phonenumber: "9876543212" });
    await api.put(`/api/clients/contacts/${c.body._id}`, { phonenumber: "9123456780" });
    expect((await Contact.findById(c.body._id)).phoneE164).toBe("+919123456780");
  });
  test("[+] contacts import", async () => {
    const r = await api.post("/api/clients/contacts/import", [{ company: "View Tabs Co", firstname: "Imp", email: "imp.contact@x.com" }]);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(1);
  });
  test("[+] note add / edit / delete", async () => {
    const n = await api.post("/api/notes", { rel_id: cid, rel_type: "customer", description: "hello" });
    expect(n.status).toBe(201);
    expect((await api.put(`/api/notes/${n.body._id}`, { description: "edited" })).body.description).toBe("edited");
    expect((await api.del(`/api/notes/${n.body._id}`)).status).toBe(200);
  });
  test("[+] file upload / list / delete", async () => {
    const up = await uploadFile(A.admin.token, cid, "doc.pdf", "%PDF-1.4 test", "application/pdf");
    expect(up.status).toBe(201);
    expect(up.body[0].file_name).toBe("doc.pdf");
    expect(fs.existsSync(path.join(UPLOAD_DIR, up.body[0].attachment_key))).toBe(true);
    const list = await api.get(`/api/clients/${cid}/files`);
    expect(list.body.length).toBe(1);
    expect((await api.del(`/api/clients/${cid}/files/${up.body[0]._id}`)).status).toBe(200);
    expect(fs.existsSync(path.join(UPLOAD_DIR, up.body[0].attachment_key))).toBe(false);
  });
  test("[+] vault add / list / delete", async () => {
    const v = await api.post(`/api/clients/${cid}/vault`, { server: "srv.example.com", port: "22", username: "root", password: "s3cret" });
    expect(v.status).toBe(201);
    expect((await api.get(`/api/clients/${cid}/vault`)).body.length).toBe(1);
    expect((await api.del(`/api/clients/vault/${v.body._id}`)).status).toBe(200);
  });
  test("[+] reminder add / list / delete", async () => {
    const r = await api.post(`/api/clients/${cid}/reminders`, { description: "Call back", date: "2026-12-01T10:00:00Z" });
    expect(r.status).toBe(201);
    expect(r.body.rel_type).toBe("customer");
    expect((await api.get(`/api/clients/${cid}/reminders`)).body.length).toBe(1);
    expect((await api.del(`/api/clients/reminders/${r.body._id}`)).status).toBe(200);
  });
});
