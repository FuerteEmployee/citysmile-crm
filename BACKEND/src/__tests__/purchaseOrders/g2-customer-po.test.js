// G2 — Customer PO reference on a Sales PO: customer_po_number (text, max 60),
// customer_po_date, optional attachment (PDF / JPG / PNG, max 10 MB, checked by
// magic bytes; own multer). List search, PDF / WhatsApp placeholder, duplicate
// warning. Cloudinary is mocked: nothing is uploaded or written to disk.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
let A, B, C;
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ctrl = () => require("../../controllers/purchase_order_controller");

const PDF = Buffer.from("%PDF-1.4 customer po");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const EXE = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");
const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
// Browsers send a file name with quotes as %22, so the file-name probe has none.
const XSS_NAME = "<img src=x onerror=window.__xss=1>";

// Uploads canary: the local uploads folders (where the real uploader would
// write without Cloudinary) must not change.
const UPLOAD_DIRS = [path.join(__dirname, "../../uploads"), path.join(__dirname, "../../../uploads")];
const snapshotUploads = () => {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    if (!fs.existsSync(d)) return h.update(`missing:${d}`);
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}:${fs.statSync(p).size}`);
    }
  };
  UPLOAD_DIRS.forEach(walk);
  return h.digest("hex");
};
let canary;

// Round 28 (R6): the customer PO fields are on the Purchase PO (Sales PO was
// removed); the helper keeps its name.
const sales = (extra = {}) => ({ type: "purchase", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)], ...extra });
const attach = (u, id, file, filename = "acme-po.pdf", type = "application/pdf") => u.api.upload(`${P}/${id}/customer-po-file`, { file, filename, type });
// Raw multipart (two files, other field names).
const rawUpload = async (u, id, parts) => {
  const form = new FormData();
  parts.forEach(([field, buf, name]) => form.append(field, new Blob([buf]), name));
  const res = await fetch(`${S.getBaseUrl()}${P}/${id}/customer-po-file`, { method: "POST", headers: { Authorization: `Bearer ${u.token}` }, body: form });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  canary = snapshotUploads();
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  C = await S.seedTenant("C", { features: [] });
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] G2", JSON.stringify(S.guardReport()), "cloudinary mocked calls", S.rec.cloudinary.length);
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(snapshotUploads()).toBe(canary);
  await S.stopStack();
});

describe("G2 UNIT", () => {
  // Round 29 (S4): the customer PO no. has a format now (letters, digits,
  // space - _ . ( ) /) — HTML is refused instead of kept as text.
  test("cleanCustomerPo: trims, max 60, HTML refused (format), '' / null clear, only sent keys returned", () => {
    const { cleanCustomerPo } = ctrl();
    expect(cleanCustomerPo({})).toEqual({});
    expect(cleanCustomerPo({ customer_po_number: "  ACME-PO-778  " })).toEqual({ customer_po_number: "ACME-PO-778" });
    expect(cleanCustomerPo({ customer_po_number: "X".repeat(60) }).customer_po_number).toHaveLength(60);
    expect(cleanCustomerPo({ customer_po_number: 778 })).toEqual({ customer_po_number: "778" });
    expect(cleanCustomerPo({ customer_po_number: "" })).toEqual({ customer_po_number: undefined });
    expect(cleanCustomerPo({ customer_po_number: null })).toEqual({ customer_po_number: undefined });
    expect(() => cleanCustomerPo({ customer_po_number: "<b>x</b>" })).toThrow("Customer PO No. can only have letters, digits, space and - _ . ( ) /");
    expect(cleanCustomerPo({ customer_po_number: "SGE/PO/2026/145" })).toEqual({ customer_po_number: "SGE/PO/2026/145" });
    expect(cleanCustomerPo({ customer_po_date: "2026-10-20" }).customer_po_date.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(cleanCustomerPo({ customer_po_date: "" })).toEqual({ customer_po_date: undefined });
    expect(cleanCustomerPo({ customer_po_date: null })).toEqual({ customer_po_date: undefined });
  });
  test.each([
    [{ customer_po_number: "X".repeat(61) }, "Customer PO No. can't be longer than 60 characters"],
    [{ customer_po_number: `  ${"X".repeat(61)}  ` }, "Customer PO No. can't be longer than 60 characters"],
    [{ customer_po_number: { $gt: "" } }, "Customer PO No.: enter text"],
    [{ customer_po_number: ["a"] }, "Customer PO No.: enter text"],
    [{ customer_po_date: "abc" }, "Customer PO date is not a valid date"],
    [{ customer_po_date: 12345 }, "Customer PO date is not a valid date"],
    [{ customer_po_date: { $gt: 1 } }, "Customer PO date is not a valid date"],
  ])("cleanCustomerPo(%j) -> 400 %s", (body, msg) => {
    expect(() => ctrl().cleanCustomerPo(body)).toThrow(msg);
  });
  test("fileKind: %PDF-, JPG FF D8 FF, PNG 89 50 4E 47 accepted; MZ, text, empty, short rejected", () => {
    const { fileKind } = ctrl();
    expect(fileKind(PDF)).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(fileKind(JPG)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(fileKind(PNG)).toEqual({ mime: "image/png", ext: "png" });
    expect(fileKind(EXE)).toBeNull();
    expect(fileKind(Buffer.from("hello, this is text"))).toBeNull();
    expect(fileKind(Buffer.alloc(0))).toBeNull();
    expect(fileKind(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(fileKind(Buffer.from("%PDF"))).toBeNull();
    expect(fileKind(undefined)).toBeNull();
  });
  test("fillPlaceholders knows {{customer_po_number}}", () => {
    expect(ctrl().fillPlaceholders("Ref {{customer_po_number}} / {{ po_number }}", { type: "sales", po_number: "SPO-1", customer_po_number: "ACME-PO-778" }))
      .toBe("Ref ACME-PO-778 / SPO-1");
    expect(ctrl().fillPlaceholders("Ref {{customer_po_number}}", { type: "sales", po_number: "SPO-1" })).toBe("Ref ");
  });
});

describe("G2 POSITIVE", () => {
  let acmePo;
  // Round 28: the customer PO is recorded on the Purchase PO (R6); every PO
  // waits for an approver's Yes (R4).
  test("Acme sends PO 'ACME-PO-778' -> Purchase PO with customer PO no. + date, I1 at 160 -> Submit -> pending -> Yes", async () => {
    const r0 = await A.users.maker.api.post(P, sales({ customer_po_number: " ACME-PO-778 ", customer_po_date: "2026-10-20", items: [S.line(A.items.I1, 2, { selling_price: 160 })], submit: true }));
    expect(r0.status).toBe(201);
    expect(r0.body).toMatchObject({ customer_po_number: "ACME-PO-778", status: "pending_approval" });
    expect(r0.body.warnings).toBeUndefined();
    const r = { status: 201, body: (await A.users.approver.api.post(`${P}/${r0.body._id}/approve`, {})).body };
    expect(r.body).toMatchObject({ customer_po_number: "ACME-PO-778", status: "approved" });
    expect(r.body.customer_po_date.slice(0, 10)).toBe("2026-10-20");
    expect(r.body.warnings).toBeUndefined();
    acmePo = r.body;
  });
  test("attach the customer's PDF -> stored (mocked uploader), shown on GET, history + Activity Log; allowed after approval", async () => {
    const n = S.rec.cloudinary.length;
    const r = await attach(A.users.maker, acmePo._id, PDF, "Acme PO 778.pdf");
    expect(r.status).toBe(200);
    expect(r.body.customer_po_file).toMatchObject({ url: S.cloudState.url, name: "Acme PO 778.pdf", size: PDF.length, mime: "application/pdf" });
    expect(String(r.body.customer_po_file.uploaded_by)).toBe(String(A.users.maker.id));
    expect(S.rec.cloudinary.slice(n)).toEqual([{ folder: "purchase_orders", originalname: `customer-po-${acmePo._id}.pdf`, size: PDF.length, head: "%PDF-1.4" }]);
    const g = (await A.users.viewer.api.get(`${P}/${acmePo._id}`)).body;
    expect(g.customer_po_file.name).toBe("Acme PO 778.pdf");
    expect(g.history.map((h) => h.action)).toContain("customer_po_file");
    expect(g.status).toBe("approved"); // the attachment never changes the status
    const log = await waitFor(() => require("../../models/ActivityLog").findOne({ rel_id: acmePo._id, description: /customer PO attached/ }).lean());
    expect(log.description).toBe(`Purchase PO ${acmePo.po_number} customer PO attached — Acme PO 778.pdf`);
  });
  test("JPG and PNG accepted (type from the bytes, not the name); a new file replaces the old one", async () => {
    const j = await attach(A.users.maker, acmePo._id, JPG, "photo.jpeg", "image/jpeg");
    expect(j.body.customer_po_file).toMatchObject({ mime: "image/jpeg", name: "photo.jpeg" });
    const p = await attach(A.users.maker, acmePo._id, PNG, "scan.png", "image/png");
    expect(p.body.customer_po_file).toMatchObject({ mime: "image/png", name: "scan.png" });
    // a real PDF with a wrong extension is still a PDF
    const odd = await attach(A.users.maker, acmePo._id, PDF, "scan.bin", "application/octet-stream");
    expect(odd.body.customer_po_file).toMatchObject({ mime: "application/pdf", name: "scan.bin" });
    expect(S.rec.cloudinary.slice(-1)[0].originalname).toBe(`customer-po-${acmePo._id}.pdf`);
  });
  test("list search by customer PO number (case-insensitive, partial)", async () => {
    const r = await A.users.viewer.api.get(`${P}?search=acme-po-77`);
    expect(r.body.data.map((p) => p.po_number)).toContain(acmePo.po_number);
    expect(r.body.data.every((p) => /acme-po-77/i.test(p.customer_po_number || "") || /acme-po-77/i.test(p.po_number))).toBe(true);
    expect(r.body.data[0].customer_po_number).toBe("ACME-PO-778");
  });
  test("edit a draft: set / change / clear the customer PO no. and date", async () => {
    const d = (await A.users.maker.api.post(P, sales({ customer_po_number: "FIRST" }))).body;
    const e1 = await A.users.maker.api.put(`${P}/${d._id}`, sales({ customer_po_number: "SECOND", customer_po_date: "2026-01-05" }));
    expect(e1.body).toMatchObject({ customer_po_number: "SECOND" });
    const e2 = await A.users.maker.api.put(`${P}/${d._id}`, sales({ customer_po_number: "", customer_po_date: null }));
    expect(e2.body.customer_po_number).toBeUndefined();
    expect(e2.body.customer_po_date).toBeUndefined();
    // not sent = unchanged
    await A.users.maker.api.put(`${P}/${d._id}`, sales({ customer_po_number: "THIRD" }));
    const e3 = await A.users.maker.api.put(`${P}/${d._id}`, sales());
    expect(e3.body.customer_po_number).toBe("THIRD");
  });
  // Round 29 (S4): REVERSED — the same customer PO no. for the same customer
  // on another (not cancelled) PO is now refused (400 with a link to that PO);
  // round 28 only warned.
  test("[REVERSED r29] same customer PO number for the same customer twice -> 400 with the other PO; other customer OK", async () => {
    const r = await A.users.maker.api.post(P, sales({ customer_po_number: "acme-po-778" }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      message: `Customer PO No. acme-po-778 is already on ${acmePo.po_number} for this customer`,
      field: "customer_po_number",
      code: "customer_po_duplicate",
      existing: [{ _id: String(acmePo._id), po_number: acmePo.po_number }],
    });
    // another customer with the same number: fine
    const other = await A.users.maker.api.post(P, sales({ customer: String(A.customers.c2._id), customer_po_number: "ACME-PO-778" }));
    expect(other.status).toBe(201);
    expect(other.body.warnings).toBeUndefined();
    // also on edit: a draft of c1 can't take the number either
    const d = (await A.users.maker.api.post(P, sales({ customer_po_number: "ACME-OTHER" }))).body;
    const e = await A.users.maker.api.put(`${P}/${d._id}`, sales({ customer_po_number: "ACME-PO-778" }));
    expect(e.status).toBe(400);
    expect(e.body.code).toBe("customer_po_duplicate");
    // re-saving a PO with its own number is fine
    expect((await A.users.maker.api.put(`${P}/${d._id}`, sales({ customer_po_number: "acme-other" }))).status).toBe(200);
  });
  test("a cancelled PO with the same number doesn't count", async () => {
    const first = (await A.users.maker.api.post(P, sales({ customer_po_number: "CANC-1" }))).body;
    await A.users.maker.api.post(`${P}/${first._id}/status`, { status: "cancelled" });
    const second = await A.users.maker.api.post(P, sales({ customer_po_number: "CANC-1" }));
    expect(second.status).toBe(201);
    expect(second.body.warnings).toBeUndefined();
  });
});

describe("G2 NEGATIVE", () => {
  let draft;
  beforeAll(async () => {
    draft = (await A.users.maker.api.post(P, sales({ customer_po_number: "NEG-1" }))).body;
  });
  const unchanged = async () => (await PurchaseOrder().findById(draft._id).lean()).customer_po_file;

  test("11 MB file -> 400 'larger than 10 MB'; nothing uploaded", async () => {
    const n = S.rec.cloudinary.length;
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    const r = await attach(A.users.maker, draft._id, big, "big.pdf");
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("The file is larger than 10 MB");
    expect(S.rec.cloudinary.length).toBe(n);
    expect(await unchanged()).toBeUndefined();
  });
  test("exactly 10 MB is accepted", async () => {
    const ten = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 - PDF.length)]);
    const r = await attach(A.users.maker, draft._id, ten, "ten.pdf");
    expect(r.status).toBe(200);
    expect(r.body.customer_po_file.size).toBe(10 * 1024 * 1024);
  });
  test.each([
    [EXE, "setup.pdf", ".exe renamed .pdf"],
    [Buffer.from("just some text"), "notes.pdf", "text"],
    [Buffer.from(XSS), "x.png", "HTML"],
    [Buffer.alloc(0), "empty.pdf", "empty"],
  ])("%#: %s -> 400 'Only a PDF, JPG or PNG' (%s); nothing uploaded", async (buf, name) => {
    const before = await unchanged();
    const n = S.rec.cloudinary.length;
    const r = await attach(A.users.maker, draft._id, buf, name);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Only a PDF, JPG or PNG file can be attached");
    expect(S.rec.cloudinary.length).toBe(n);
    expect(await unchanged()).toEqual(before);
  });
  test("two files, a wrong field name, or no file -> 400", async () => {
    const two = await rawUpload(A.users.maker, draft._id, [["file", PDF, "a.pdf"], ["file", PDF, "b.pdf"]]);
    expect(two).toEqual({ status: 400, body: { message: "Attach one file (PDF, JPG or PNG)" } });
    const wrong = await rawUpload(A.users.maker, draft._id, [["document", PDF, "a.pdf"]]);
    expect(wrong.status).toBe(400);
    const none = await A.users.maker.api.upload(`${P}/${draft._id}/customer-po-file`, {});
    expect(none).toEqual({ status: 400, body: { message: "Attach the customer's PO (PDF, JPG or PNG)" } });
  });
  test("file name with HTML is stored as plain text (shown escaped by the UI)", async () => {
    const r = await attach(A.users.maker, draft._id, PDF, `${XSS_NAME}.pdf`);
    expect(r.status).toBe(200);
    expect(r.body.customer_po_file.name).toBe(`${XSS_NAME}.pdf`);
    // the stored file never uses the uploaded name
    expect(S.rec.cloudinary.slice(-1)[0].originalname).toBe(`customer-po-${draft._id}.pdf`);
  });
  test("customer_po_number 61 chars / object -> 400 on create and edit; nothing saved", async () => {
    const count = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    for (const bad of ["X".repeat(61), { $ne: null }]) {
      expect((await A.users.maker.api.post(P, sales({ customer_po_number: bad }))).status).toBe(400);
      expect((await A.users.maker.api.put(`${P}/${draft._id}`, sales({ customer_po_number: bad }))).status).toBe(400);
    }
    expect((await A.users.maker.api.post(P, sales({ customer_po_date: "31-31-2026" }))).body.message).toBe("Customer PO date is not a valid date");
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(count);
    expect((await PurchaseOrder().findById(draft._id).lean()).customer_po_number).toBe("NEG-1");
  });
  // Round 29 (S4): REVERSED — HTML is refused by the format rule (never stored).
  test("[REVERSED r29] HTML customer PO number -> 400 (format), nothing saved", async () => {
    const count = await PurchaseOrder().countDocuments({ tenant_id: A.tenantId });
    const r = await A.users.maker.api.post(P, sales({ customer_po_number: XSS.slice(0, 60) }));
    expect(r.status).toBe(400);
    expect(r.body.field).toBe("customer_po_number");
    expect(await PurchaseOrder().countDocuments({ tenant_id: A.tenantId })).toBe(count);
  });
  // REVERSED by R6: the Purchase PO now keeps the customer PO; an OLD Sales PO is read-only.
  test("[REVERSED R6] Purchase PO keeps the customer PO fields; an old Sales PO can't get a file (read-only)", async () => {
    const p = await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)], customer_po_number: "KEPT", customer_po_date: "2026-01-01" });
    expect(p.status).toBe(201);
    expect(p.body.customer_po_number).toBe("KEPT");
    expect(p.body.customer_po_date.slice(0, 10)).toBe("2026-01-01");
    expect((await attach(A.users.maker, p.body._id, PDF)).status).toBe(200);
    const old = await S.insertSalesPo(A);
    const r = await attach(A.users.maker, old._id, PDF);
    expect(r).toEqual({ status: 400, body: { message: "Old Sales POs are read-only (Sales PO was removed)" } });
  });
  test("cancelled PO -> 400", async () => {
    const c = (await A.users.maker.api.post(P, sales())).body;
    await A.users.maker.api.post(`${P}/${c._id}/status`, { status: "cancelled" });
    expect((await attach(A.users.maker, c._id, PDF)).body).toEqual({ message: "This PO is cancelled" });
  });
  test("permissions: viewer / approver / pricer -> 403; maker2 (Edit) may attach to maker's PO; own staff can't see others' PO -> 404", async () => {
    for (const u of ["viewer", "approver", "pricer"]) {
      expect((await attach(A.users[u], draft._id, PDF)).status).toBe(403);
    }
    expect((await attach(A.users.maker2, draft._id, PDF)).status).toBe(200);
    expect((await attach(A.users.own, draft._id, PDF)).status).toBe(404);
    // Round 29 (S4): the file needs the Customer PO No. on the PO first.
    const mine = (await A.users.own.api.post(P, sales({ customer_po_number: "OWN-FILE-1" }))).body;
    expect((await attach(A.users.own, mine._id, PDF)).status).toBe(200); // own PO with Create
  });
  test("another company's PO -> 404, invalid id -> 404; B unchanged", async () => {
    const b = (await B.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(B.customers.c1._id), items: [S.line(B.items.I1, 1)] })).body;
    expect((await attach(A.users.admin, b._id, PDF)).status).toBe(404);
    expect((await attach(A.users.admin, "nope", PDF)).status).toBe(404);
    expect((await PurchaseOrder().findById(b._id).lean()).customer_po_file).toBeUndefined();
  });
  test("Tenant C (add-on off) -> 403; no token -> 401", async () => {
    const id = draft._id;
    expect((await attach(C.users.admin, id, PDF)).status).toBe(403);
    expect((await S.api(null).upload(`${P}/${id}/customer-po-file`, { file: PDF })).status).toBe(401);
  });
});

describe("G2 INTEGRATION", () => {
  test("WhatsApp template param {{customer_po_number}} is filled from the Purchase PO (send mocked)", async () => {
    await A.users.admin.api.put(`${P}/settings`, { whatsapp: { template_name: "po_doc", template_language: "en", body_params: ["{{po_number}}", "{{customer_po_number}}"] } });
    const pend = (await A.users.maker.api.post(P, sales({ customer_po_number: "ACME-WA-1", submit: true }))).body;
    const po = (await A.users.approver.api.post(`${P}/${pend._id}/approve`, {})).body; // R4
    expect(po.status).toBe("approved");
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9876543210" } });
    expect(r.status).toBe(200);
    const tpl = S.rec.whatsapp.slice(n).find((c) => c.fn === "sendDocumentTemplate");
    expect(tpl.params).toEqual([po.po_number, "ACME-WA-1"]);
    expect(tpl.mobile).toBe("9876543210");
  });
  test("company separation in search: A's search never returns B's PO with the same customer PO number", async () => {
    await B.users.maker.api.post(P, { type: "purchase", division: "brady", customer: String(B.customers.c1._id), items: [S.line(B.items.I1, 1)], customer_po_number: "SHARED-NO" });
    await A.users.maker.api.post(P, sales({ customer_po_number: "SHARED-NO" }));
    const r = await A.users.viewer.api.get(`${P}?search=SHARED-NO`);
    expect(r.body.total).toBe(1);
    expect(String(r.body.data[0].tenant_id)).toBe(String(A.tenantId));
  });
  test("View (Own): search by customer PO number only finds own POs", async () => {
    await A.users.maker.api.post(P, sales({ customer_po_number: "OWN-SCOPE" }));
    // Round 29 (S4): another customer — the same no. for the same customer is refused now.
    await A.users.own.api.post(P, sales({ customer: String(A.customers.c2._id), customer_po_number: "OWN-SCOPE" }));
    const r = await A.users.own.api.get(`${P}?search=OWN-SCOPE`);
    expect(r.body.total).toBe(1);
    expect(String(r.body.data[0].created_by._id)).toBe(String(A.users.own.id));
  });
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
