// PART 4 — Status moves, PDF data, WhatsApp send (all WhatsApp / Cloudinary calls mocked).
// "[BUG]" / "[RECORD]" / "[QUESTION]" tests assert the CURRENT behaviour.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const { fillPlaceholders } = require("../../controllers/purchase_order_controller");

jest.setTimeout(240000);
const P = S.PO_PATH;
let A, B;
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ActivityLog = () => require("../../models/ActivityLog");
const WhatsAppInbox = () => require("../../models/WhatsAppInbox");
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const PDF = Buffer.from("%PDF-1.4\n% test po\n%%EOF");
const STATUSES = ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "cancelled"];
const ALLOWED = {
  draft: ["cancelled"],
  pending_approval: ["cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received", "cancelled"],
  received: [],
  cancelled: [],
};
// The PDF name sent on WhatsApp: the PO number with "/" made file-safe (R2 numbers "PPO/01/26-27").
const fileOf = (po) => `${po.po_number.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
// Body for a move: partially_received now needs received quantities.
const moveBody = (po, status) => (status === "partially_received" ? { status, received: [{ line_id: String(po.items[0]._id), qty_received: 1 }] } : { status });

// Canary: the local uploads folder must not change (uploads are mocked).
const uploadsDir = path.join(__dirname, "../../uploads");
const dirHash = () => {
  if (!fs.existsSync(uploadsDir)) return "missing";
  const h = crypto.createHash("sha256");
  fs.readdirSync(uploadsDir).sort().forEach((f) => { const st = fs.statSync(path.join(uploadsDir, f)); h.update(`${f}:${st.size}:${st.mtimeMs}`); });
  return h.digest("hex");
};
let canaryBefore;

// Brings a new PO (tenant A) to `status`.
const poAt = async (status, { type = "purchase" } = {}) => {
  const U = A.users;
  // qty 2 so a partial delivery (1 of 2) is possible
  const body = { type, division: "brady", items: [S.line(A.items.I1, 2)], ...(type === "sales" ? { customer: String(A.customers.c1._id) } : {}) };
  if (status === "draft") return (await U.maker.api.post(P, body)).body;
  if (status === "pending_approval") return (await U.maker.api.post(P, { ...body, items: [S.line(A.items.I1, 2, { selling_price: 175 })], submit: true })).body;
  if (status === "cancelled") {
    const d = (await U.maker.api.post(P, body)).body;
    return (await U.admin.api.post(`${P}/${d._id}/status`, { status: "cancelled" })).body;
  }
  // R4: every PO waits for a Yes — the admin's own PO is approved by the admin.
  const pending = (await U.admin.api.post(P, { ...body, submit: true })).body;
  const po = (await U.admin.api.post(`${P}/${pending._id}/approve`, {})).body;
  const path2 = { approved: [], sent: ["sent"], partially_received: ["sent", "partially_received"], received: ["sent", "received"] }[status];
  let cur = po;
  for (const s of path2) cur = (await U.admin.api.post(`${P}/${po._id}/status`, moveBody(po, s))).body;
  return cur;
};

beforeAll(async () => {
  canaryBefore = dirHash();
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
  delete process.env.BACKEND_PUBLIC_URL;
});

afterAll(async () => {
  const canaryAfter = dirHash();
  console.log("[guard] PART4", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, waMockedCalls: S.rec.whatsapp.length, waFns: [...new Set(S.rec.whatsapp.map((w) => w.fn))], cloudMockedCalls: S.rec.cloudinary.length }), "uploads canary", canaryBefore === canaryAfter ? "UNCHANGED" : "CHANGED");
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(canaryAfter).toBe(canaryBefore);
  await S.stopStack();
});

describe("4.1 UNIT", () => {
  test("7x7 status move table through POST /:id/status", async () => {
    const table = {};
    for (const from of STATUSES) {
      table[from] = {};
      for (const to of STATUSES) {
        const po = await poAt(from);
        expect(po.status).toBe(from);
        const r = await A.users.admin.api.post(`${P}/${po._id}/status`, moveBody(po, to));
        table[from][to] = r.status;
        expect(r.status).toBe(ALLOWED[from].includes(to) ? 200 : 400);
      }
    }
    console.log("[status-table]", JSON.stringify(table));
  });

  test("fillPlaceholders: every key, spaces, unknown key kept", () => {
    const po = { type: "purchase", po_number: "PPO-2026-0007", po_date: new Date("2026-03-05"), expected_date: null, supplier: { name: "Brady" }, customer_snapshot: { name: "Acme" }, totals: { grand_total: 1234.5 } };
    expect(fillPlaceholders("{{po_number}}|{{ party_name }}|{{customer.name}}|{{supplier.name}}|{{grand_total}}|{{expected_date}}|{{unknown}}|{{po_date}}", po))
      .toBe(`PPO-2026-0007|Brady|Acme|Brady|1234.50||{{unknown}}|${new Date("2026-03-05").toLocaleDateString("en-IN")}`);
    expect(fillPlaceholders("{{party_name}}", { ...po, type: "sales" })).toBe("Acme");
    expect(fillPlaceholders(undefined, po)).toBe("");
    expect(fillPlaceholders("{{grand_total}}", { ...po, totals: undefined })).toBe("0.00");
  });
});

describe("4.2 POSITIVE", () => {
  test("full life cycle draft -> approved -> sent -> partially_received -> received; history + Activity Log", async () => {
    const d = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 4), S.line(A.items.I5, 2)] })).body;
    const sub0 = await A.users.maker.api.post(`${P}/${d._id}/submit`, {});
    expect(sub0.body.status).toBe("pending_approval"); // R4
    const sub = await A.users.approver.api.post(`${P}/${d._id}/approve`, {});
    expect(sub.body.status).toBe("approved");
    const [l1, l2] = sub.body.items.map((l) => String(l._id));
    for (const s of ["sent", "partially_received", "received"]) {
      const body = { status: s, note: ` note ${s} `, ...(s === "partially_received" ? { received: [{ line_id: l1, qty_received: 3 }] } : {}) };
      const r = await A.users.maker.api.post(`${P}/${d._id}/status`, body);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(s);
      if (s === "partially_received") expect(r.body.items.map((l) => l.qty_received)).toEqual([3, 0]);
      if (s === "received") expect(r.body.items.map((l) => l.qty_received)).toEqual([4, 2]);
    }
    expect(l2).toBeDefined();
    const g = (await A.users.maker.api.get(`${P}/${d._id}`)).body;
    expect(g.history.map((h) => h.action)).toEqual(["created", "submitted", "approved", "status:sent", "status:partially_received", "status:received"]);
    expect(g.history[3].note).toBe("note sent");
    const rows = await waitFor(async () => { const x = await ActivityLog().find({ rel_id: d._id }).lean(); return x.length >= 5 ? x : null; });
    expect(rows.map((r) => r.description)).toEqual(expect.arrayContaining([`Purchase PO ${d.po_number} marked partially received — note partially_received`, `Purchase PO ${d.po_number} marked received — note received`]));
  });

  test("partially received: deliveries recorded per line, later delivery (partial -> partial) updates only the listed line; default history note", async () => {
    const d = await S.approvedPo(A, [S.line(A.items.I1, 4), S.line(A.items.I5, 2)], {}, { maker: "admin", approver: "admin" });
    const [l1, l2] = d.items.map((l) => String(l._id));
    await A.users.admin.api.post(`${P}/${d._id}/status`, { status: "sent" });
    const p1 = await A.users.admin.api.post(`${P}/${d._id}/status`, { status: "partially_received", received: [{ line_id: l1, qty_received: 1 }, { line_id: l2, qty_received: "0.5" }] });
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((l) => l.qty_received)).toEqual([1, 0.5]);
    expect(p1.body.history[p1.body.history.length - 1].note).toBe("I1 Label A: 1/4, I5 Brady A: 0.5/2");
    const p2 = await A.users.admin.api.post(`${P}/${d._id}/status`, { status: "partially_received", received: [{ line_id: l1, qty_received: 4 }], note: "2nd truck" });
    expect(p2.status).toBe(200);
    expect(p2.body.items.map((l) => l.qty_received)).toEqual([4, 0.5]);
    expect(p2.body.history[p2.body.history.length - 1].note).toBe("2nd truck");
    const rec = await A.users.admin.api.post(`${P}/${d._id}/status`, { status: "received" });
    expect(rec.body.items.map((l) => l.qty_received)).toEqual([4, 2]);
    const db = await PurchaseOrder().findById(d._id).lean();
    expect(db.items.map((l) => l.qty_received)).toEqual([4, 2]);
  });

  test("[FIXED] Activity Log for a partial delivery without a note carries the 'Name: x/y' quantities; a typed note wins", async () => {
    const po = await poAt("partially_received");
    const log = await waitFor(() => ActivityLog().findOne({ rel_id: po._id, description: /partially received/ }).lean());
    expect(log.description).toBe(`Purchase PO ${po.po_number} marked partially received — I1 Label A: 1/2`);
    const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received: [{ line_id: String(po.items[0]._id), qty_received: 1.5 }], note: "truck 2" });
    expect(r.status).toBe(200);
    const log2 = await waitFor(() => ActivityLog().findOne({ rel_id: po._id, description: /truck 2/ }).lean());
    expect(log2.description).toBe(`Purchase PO ${po.po_number} marked partially received — truck 2`);
  });

  test("cancel from each allowed state", async () => {
    for (const from of ["draft", "pending_approval", "approved", "sent", "partially_received"]) {
      const po = await poAt(from);
      expect((await A.users.maker.api.post(`${P}/${po._id}/status`, { status: "cancelled" })).body.status).toBe("cancelled");
    }
  });

  // Q1: the purchase PO rate is the Master Distributor Price (I1: 150).
  test("PDF data: purchase PO rate = cost (MDP); old sales PO keeps its selling-price rate; format attached", async () => {
    const p = (await A.users.admin.api.get(`${P}/${(await poAt("approved"))._id}`)).body;
    expect(p.items[0]).toMatchObject({ rate: 150, cost_price: 150, selling_price: 160 });
    expect(p.format.columns.map((c) => c.key)).toEqual(["sr", "item_code", "name", "hsn", "qty", "unit", "rate", "discount", "tax", "amount"]);
    const old = await S.insertSalesPo(A, { status: "approved" });
    const s = (await A.users.admin.api.get(`${P}/${old._id}`)).body;
    expect(s.items[0]).toMatchObject({ rate: 160, selling_price: 160, cost_price: 100 });
  });

  test("WhatsApp inside the 24h window -> document message; approved -> sent; logs + inbox row (4.5)", async () => {
    const po = await poAt("approved");
    await WhatsAppInbox().create({ tenant_id: A.tenantId, from: "919876543210", mobile: "9876543210", direction: "in", message: "hi", received_at: new Date(Date.now() - 3600e3) });
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, filename: "x.pdf", fields: { to: "9876543210" } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("sent");
    const calls = S.rec.whatsapp.slice(n);
    expect(calls.map((c) => c.fn)).toEqual(["getActiveIntegration", "sendDocumentMessage"]);
    expect(calls[1]).toMatchObject({ mobile: "9876543210", url: "https://files.test.invalid/po.pdf", filename: fileOf(po), caption: po.po_number });
    expect(S.rec.cloudinary[S.rec.cloudinary.length - 1]).toMatchObject({ folder: "purchase_orders", originalname: fileOf(po), head: "%PDF-1.4" });
    expect(r.body.whatsapp_log).toEqual([expect.objectContaining({ to: "9876543210", method: "document", status: "sent", message_id: "wamid.DOC" })]);
    expect(r.body.history.map((h) => h.action).slice(-2)).toEqual(["whatsapp", "status:sent"]);
    const inbox = await waitFor(() => WhatsAppInbox().findOne({ tenant_id: A.tenantId, direction: "out", wa_message_id: "wamid.DOC" }).lean());
    expect(inbox).toMatchObject({ mobile: "9876543210", msg_type: "document", message: fileOf(po), media_url: "https://files.test.invalid/po.pdf", delivery_status: "sent", from: "919000000000" });
    const log = await waitFor(() => ActivityLog().findOne({ rel_id: po._id, description: /sent on WhatsApp/ }).lean());
    expect(log.description).toBe(`Purchase PO ${po.po_number} sent on WhatsApp — to 9876543210`);
  });

  test("WhatsApp outside the window with template -> template with filled params (finding 4b)", async () => {
    await A.users.admin.api.put(`${P}/settings`, { whatsapp: { template_name: "po_doc", template_language: "en_US", body_params: ["{{po_number}}", "{{party_name}}", "{{grand_total}}", "{{nope}}"] }, supplier: { name: "Brady", whatsapp: "+91 90000 11111" } });
    const po = await poAt("approved"); // purchase -> supplier whatsapp (snapshotted at create)
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF });
    expect(r.status).toBe(200);
    const call = S.rec.whatsapp.slice(n).find((c) => c.fn === "sendDocumentTemplate");
    expect(call).toMatchObject({ mobile: "919000011111", template: "po_doc", lang: "en_US", params: [po.po_number, "Brady", po.totals.grand_total.toFixed(2), "{{nope}}"] });
    expect(r.body.whatsapp_log[0]).toMatchObject({ method: "template", status: "sent" });
  });

  test("sent PO can be re-sent and stays 'sent'; received PO can be sent (SENDABLE, finding 4a)", async () => {
    for (const st of ["sent", "partially_received", "received"]) {
      const po = await poAt(st);
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(st);
    }
  });

  test("'to' overrides the default; formatted numbers are reduced to digits", async () => {
    const po = await poAt("approved");
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "+91 (912) 345-6789" } });
    expect(r.status).toBe(200);
    expect(S.rec.whatsapp.slice(n).find((c) => c.fn.startsWith("send")).mobile).toBe("919123456789");
  });
});

describe("4.3 NEGATIVE", () => {
  test("status 'xyz', missing, object, approved-by-hand -> 400", async () => {
    const po = await poAt("draft");
    for (const status of ["xyz", undefined, { $ne: "x" }, "approved", "pending_approval", "draft", ""]) {
      const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status });
      expect(r.status).toBe(400);
    }
  });
  test("status change without Edit cap -> 403 (approver, viewer, own)", async () => {
    const po = await poAt("approved");
    for (const u of ["approver", "viewer", "own", "pricer"]) {
      expect((await A.users[u].api.post(`${P}/${po._id}/status`, { status: "sent" })).status).toBe(403);
    }
  });
  test("WhatsApp on draft / pending / cancelled -> 400", async () => {
    for (const st of ["draft", "pending_approval", "cancelled"]) {
      const po = await poAt(st);
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Only an approved PO can be sent");
    }
  });
  test("partially_received rules: missing / empty / unknown line / over qty / negative / text / total 0 / all full -> 400; PO unchanged", async () => {
    const po = await poAt("sent"); // one line, qty 2
    const id = String(po.items[0]._id);
    const cases = [
      [undefined, "Enter the received quantity for at least one item"],
      [[], "Enter the received quantity for at least one item"],
      [{ line_id: id, qty_received: 1 }, "Enter the received quantity for at least one item"],
      [[{ line_id: String(new mongoose.Types.ObjectId()), qty_received: 1 }], "Unknown item line"],
      [[{ line_id: "bad", qty_received: 1 }], "Unknown item line"],
      [[null], "Unknown item line"],
      [[{ line_id: id, qty_received: 3 }], "I1 Label A: received quantity can't be more than 2"],
      [[{ line_id: id, qty_received: -1 }], "I1 Label A: received quantity can't be negative"],
      [[{ line_id: id, qty_received: "abc" }], "I1 Label A: received quantity: enter a number"],
      [[{ line_id: id }], "I1 Label A: enter the received quantity"],
      [[{ line_id: id, qty_received: 0 }], "Nothing received yet — enter a received quantity"],
      [[{ line_id: id, qty_received: 2 }], "Everything has arrived — mark the PO as Received instead"],
    ];
    for (const [received, msg] of cases) {
      const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(msg);
    }
    const db = await PurchaseOrder().findById(po._id).lean();
    expect(db.status).toBe("sent");
    expect(db.items[0].qty_received).toBe(0);
  });

  test("partially_received: a line of ANOTHER PO / another company -> 'Unknown item line'", async () => {
    const po = await poAt("sent");
    const other = await poAt("sent");
    const bpo = (await B.users.admin.api.post(P, { type: "purchase", division: "brady", items: [S.line(B.items.I1, 2)], submit: true })).body;
    for (const lid of [other.items[0]._id, bpo.items[0]._id]) {
      const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received: [{ line_id: String(lid), qty_received: 1 }] });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Unknown item line");
    }
  });

  test("partial -> partial lowering everything to 0 -> 400 'Nothing received yet'", async () => {
    const po = await poAt("partially_received");
    const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received: [{ line_id: String(po.items[0]._id), qty_received: 0 }] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Nothing received yet — enter a received quantity");
    expect((await PurchaseOrder().findById(po._id).lean()).items[0].qty_received).toBe(1);
  });

  test("[RECORD] received quantity can go DOWN on a later partial delivery (2nd entry 1 -> 0.5)", async () => {
    const po = await poAt("partially_received");
    const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received: [{ line_id: String(po.items[0]._id), qty_received: 0.5 }] });
    expect(r.status).toBe(200);
    expect(r.body.items[0].qty_received).toBe(0.5);
  });

  test("WhatsApp with no file -> 400", async () => {
    const po = await poAt("approved");
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { fields: { to: "9123456789" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("The PO PDF is missing");
  });
  test("WhatsApp to '123' -> 400 (finding 4e)", async () => {
    const po = await poAt("approved");
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "123" } });
    expect(r.status).toBe(400);
  });
  test("WhatsApp with no integration -> 400 'Connect a WhatsApp number first'", async () => {
    const po = await poAt("approved");
    const saved = S.waState.integration;
    S.waState.integration = null;
    try {
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/Connect a WhatsApp number first/);
    } finally {
      S.waState.integration = saved;
    }
  });
  // R1: an old Sales PO is read-only — it is never sent on WhatsApp.
  test("old sales PO (approved) -> WhatsApp 400 read-only, nothing sent", async () => {
    const d = await S.insertSalesPo(A, { status: "approved", customer: A.customers.noPhone });
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${d._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/read-only/);
    expect(S.rec.whatsapp.length).toBe(n);
  });
  test("WhatsApp without Edit cap -> 403", async () => {
    const po = await poAt("approved");
    for (const u of ["approver", "viewer", "own"]) {
      expect((await A.users[u].api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } })).status).toBe(403);
    }
  });
  test("WhatsApp on a Tenant B PO -> 404, nothing sent", async () => {
    const bpo = await S.approvedPo(B, [S.line(B.items.I1, 1)], {}, { maker: "admin", approver: "admin" });
    const n = S.rec.whatsapp.length;
    const r = await A.users.admin.api.upload(`${P}/${bpo._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
    expect(r.status).toBe(404);
    expect(S.rec.whatsapp.length).toBe(n);
  });
});

describe("FINDINGS + 4.5 INTEGRATION", () => {
  test("outside the window and NO template -> 400 with clear message; status stays approved; log 'failed' (4b, 4.5)", async () => {
    await A.users.admin.api.put(`${P}/settings`, { whatsapp: { template_name: "" } });
    const po = await poAt("approved");
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9111111111" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/hasn't messaged you in the last 24 hours/);
    expect(r.body.po.status).toBe("approved");
    expect(r.body.po.whatsapp_log[0]).toMatchObject({ method: "template", status: "failed" });
    expect(S.rec.whatsapp.slice(n).map((c) => c.fn)).toEqual(["getActiveIntegration"]);
    const db = await PurchaseOrder().findById(po._id).lean();
    expect(db.status).toBe("approved");
    expect(db.history.map((h) => h.action)).not.toContain("whatsapp");
  });

  test("failed send from Meta -> 400; status stays approved; whatsapp_log failed with error (4.5)", async () => {
    await WhatsAppInbox().create({ tenant_id: A.tenantId, from: "919222222222", mobile: "9222222222", direction: "in", message: "hi", received_at: new Date() });
    S.waState.documentResult = { success: false, error: "(#131047) Re-engagement message" };
    try {
      const po = await poAt("approved");
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9222222222" } });
      expect(r.status).toBe(400);
      expect(r.body.po.status).toBe("approved");
      expect(r.body.po.whatsapp_log[0]).toMatchObject({ status: "failed", error: "(#131047) Re-engagement message", method: "document" });
      expect(await WhatsAppInbox().countDocuments({ tenant_id: A.tenantId, direction: "out", mobile: "9222222222" })).toBe(0);
    } finally {
      S.waState.documentResult = { success: true, messageId: "wamid.DOC" };
    }
  });

  test("[QUESTION] test-mode send (skipped/simulated) still moves the PO to 'sent' (no inbox row)", async () => {
    S.waState.templateResult = { success: true, skipped: true, messageId: "SIMULATED-1" };
    await A.users.admin.api.put(`${P}/settings`, { whatsapp: { template_name: "po_doc" } });
    try {
      const po = await poAt("approved");
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9333333333" } });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("sent");
      expect(r.body.whatsapp_log[0].status).toBe("simulated");
      expect(r.body.history.find((h) => h.action === "whatsapp").note).toMatch(/test mode/);
      await new Promise((res) => setTimeout(res, 200));
      expect(await WhatsAppInbox().countDocuments({ mobile: "9333333333", direction: "out" })).toBe(0);
    } finally {
      S.waState.templateResult = { success: true, messageId: "wamid.TPL" };
    }
  });

  const pdfOf = (size) => Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(size - 9, 0x41)]);
  test("[FIXED] 4d: a 30 MB file -> 400 'The PDF is larger than 10 MB'; nothing uploaded or sent", async () => {
    const po = await poAt("approved");
    const c = S.rec.cloudinary.length;
    const w = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: pdfOf(30 * 1024 * 1024), fields: { to: "9123456789" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("The PDF is larger than 10 MB");
    expect(S.rec.cloudinary.length).toBe(c);
    expect(S.rec.whatsapp.length).toBe(w);
    expect((await PurchaseOrder().findById(po._id).lean()).status).toBe("approved");
  });

  test("size boundary: 10 MB - 1 byte -> 200; 10 MB + 1 byte -> 400", async () => {
    const ok = await poAt("approved");
    const r1 = await A.users.maker.api.upload(`${P}/${ok._id}/whatsapp`, { file: pdfOf(10 * 1024 * 1024 - 1), fields: { to: "9123456789" } });
    expect(r1.status).toBe(200);
    expect(S.rec.cloudinary[S.rec.cloudinary.length - 1].size).toBe(10 * 1024 * 1024 - 1);
    const bad = await poAt("approved");
    const r2 = await A.users.maker.api.upload(`${P}/${bad._id}/whatsapp`, { file: pdfOf(10 * 1024 * 1024 + 1), fields: { to: "9123456789" } });
    expect(r2.status).toBe(400);
  });

  test("[FIXED] a PDF of EXACTLY 10 MB (10,485,760 bytes) is accepted; 10 MB + 1 byte -> 400", async () => {
    const po = await poAt("approved");
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: pdfOf(10 * 1024 * 1024), fields: { to: "9123456789" } });
    expect(r.status).toBe(200);
    expect(S.rec.cloudinary[S.rec.cloudinary.length - 1].size).toBe(10 * 1024 * 1024);
    const po2 = await poAt("approved");
    const r2 = await A.users.maker.api.upload(`${P}/${po2._id}/whatsapp`, { file: pdfOf(10 * 1024 * 1024 + 1), fields: { to: "9123456789" } });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toBe("The PDF is larger than 10 MB");
  });

  test("[FIXED] 4d: a Windows .exe (MZ header) named .pdf -> 400 'Only a PDF file can be sent'; nothing uploaded", async () => {
    const po = await poAt("approved");
    const c = S.rec.cloudinary.length;
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(1024)]);
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: exe, filename: "evil.pdf", type: "application/x-msdownload", fields: { to: "9123456789" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Only a PDF file can be sent");
    expect(S.rec.cloudinary.length).toBe(c);
  });

  test("type check: empty file, text, ' %PDF-' with a leading space -> 400; a small real %PDF- buffer -> 200", async () => {
    for (const buf of [Buffer.alloc(0), Buffer.from("hello world"), Buffer.from(" %PDF-1.4"), Buffer.from("%PDF")]) {
      const po = await poAt("approved");
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: buf, fields: { to: "9123456789" } });
      expect(r.status).toBe(400);
    }
    const po = await poAt("approved");
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF"), fields: { to: "9123456789" } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("sent");
  });

  test("upload shape: two files / wrong field name -> 400 'Upload one PDF file'", async () => {
    const po = await poAt("approved");
    const send = async (fields) => {
      const form = new FormData();
      form.append("to", "9123456789");
      fields.forEach((f) => form.append(f, new Blob([PDF], { type: "application/pdf" }), "a.pdf"));
      const res = await fetch(`${S.getBaseUrl()}${P}/${po._id}/whatsapp`, { method: "POST", headers: { Authorization: `Bearer ${A.users.maker.token}` }, body: form });
      return { status: res.status, body: await res.json() };
    };
    const two = await send(["file", "file"]);
    expect(two.status).toBe(400);
    expect(two.body.message).toBe("Upload one PDF file");
    const wrong = await send(["document"]);
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe("Upload one PDF file");
  });

  test("[RECORD] the 10 MB limit is checked BEFORE login/permission? (upload runs after the router-level auth)", async () => {
    const po = await poAt("approved");
    const r = await A.users.viewer.api.upload(`${P}/${po._id}/whatsapp`, { file: pdfOf(11 * 1024 * 1024), fields: { to: "9123456789" } });
    console.log("[record] viewer + 11 MB ->", r.status, r.body.message);
    expect([400, 403]).toContain(r.status);
  });

  test("4e: default recipient = supplier WhatsApp snapshot (purchase) — a PO made before the number was set has none", async () => {
    // supplier snapshot is taken at create; reset supplier whatsapp to empty, create, then set it
    await A.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady", whatsapp: "", phone: "" } });
    const old = await poAt("approved");
    await A.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady", whatsapp: "9444444444" } });
    const r = await A.users.maker.api.upload(`${P}/${old._id}/whatsapp`, { file: PDF });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Add the supplier's WhatsApp number in PO Settings");
    const fresh = await poAt("approved");
    const n = S.rec.whatsapp.length;
    const ok = await A.users.maker.api.upload(`${P}/${fresh._id}/whatsapp`, { file: PDF });
    expect(ok.status).toBe(200);
    expect(S.rec.whatsapp.slice(n).find((c) => c.fn.startsWith("send")).mobile).toBe("9444444444");
  });

  // R1: old Sales POs are not sent any more; formatted numbers still reduce
  // to digits (supplier number '+91 98765 43211').
  test("[REVERSED R1] 4e: old sales PO is not sent; a formatted supplier number '+91 98765 43211' -> digits", async () => {
    const old = await S.insertSalesPo(A, { status: "approved", customer: A.customers.c2 });
    expect((await A.users.maker.api.upload(`${P}/${old._id}/whatsapp`, { file: PDF })).status).toBe(400);
    await A.users.admin.api.put(`${P}/settings`, { supplier: { name: "Brady", whatsapp: "+91 98765 43211" } });
    const d = await poAt("approved");
    const n = S.rec.whatsapp.length;
    const r = await A.users.maker.api.upload(`${P}/${d._id}/whatsapp`, { file: PDF });
    expect(r.status).toBe(200);
    expect(S.rec.whatsapp.slice(n).find((c) => c.fn.startsWith("send")).mobile).toBe("919876543211");
  });

  test("[FIXED] 4f: partially_received stores the received quantity per line", async () => {
    const po = await poAt("sent");
    const r = await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "partially_received", received: [{ line_id: String(po.items[0]._id), qty_received: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.items[0].qty_received).toBe(1);
    expect((await PurchaseOrder().findById(po._id).lean()).items[0].qty_received).toBe(1);
  });

  test("[FIXED] WhatsApp send racing a status change: every sent message is recorded (log, history, Activity Log, inbox) and the cancel is kept", async () => {
    const out = { rounds: 0, sentButNotLogged: 0, wa200: 0, outcomes: {} };
    for (let i = 0; i < 8; i++) {
      const po = await poAt("approved");
      const n = S.rec.whatsapp.filter((c) => c.fn.startsWith("send")).length;
      const [w, s] = await Promise.all([
        A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } }),
        A.users.admin.api.post(`${P}/${po._id}/status`, { status: "cancelled" }),
      ]);
      const db = await PurchaseOrder().findById(po._id).lean();
      const sends = S.rec.whatsapp.filter((c) => c.fn.startsWith("send")).length - n;
      out.rounds += 1;
      const k = `wa${w.status}/status${s.status}/final:${db.status}`;
      out.outcomes[k] = (out.outcomes[k] || 0) + 1;
      if (sends > 0 && db.whatsapp_log.length === 0) out.sentButNotLogged += 1;
      expect(s.status).toBe(200);
      expect(db.status).toBe("cancelled"); // the cancel is never flipped back to "sent"
      if (w.status === 200) {
        out.wa200 += 1;
        expect(sends).toBe(1);
        expect(db.whatsapp_log).toHaveLength(1);
        expect(db.whatsapp_log[0]).toMatchObject({ to: "9123456789", status: "sent" });
        expect(db.history.map((h) => h.action)).toEqual(expect.arrayContaining(["whatsapp", "status:cancelled"]));
        const log = await waitFor(() => ActivityLog().findOne({ rel_id: po._id, description: /sent on WhatsApp/ }).lean());
        expect(log).not.toBeNull();
        const inbox = await waitFor(() => WhatsAppInbox().findOne({ tenant_id: A.tenantId, direction: "out", message: fileOf(po) }).lean());
        expect(inbox).not.toBeNull();
      } else {
        // send lost before sending (PO already cancelled when it loaded)
        expect(w.status).toBe(400);
        expect(sends).toBe(0);
      }
    }
    console.log("[record] parallel whatsapp+cancel x8 ->", JSON.stringify(out));
    expect(out.sentButNotLogged).toBe(0);
    expect(out.wa200).toBeGreaterThan(0);
  });

  test("normal send still moves approved -> sent (atomic update path) and returns the reloaded PO", async () => {
    const po = await poAt("approved");
    const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("sent");
    expect(r.body.history.map((h) => h.action).slice(-2)).toEqual(["whatsapp", "status:sent"]);
    expect(r.body.whatsapp_log).toHaveLength(1);
    const db = await PurchaseOrder().findById(po._id).lean();
    expect(db.status).toBe("sent");
    // the PO can still be changed afterwards (no stale version left behind)
    expect((await A.users.admin.api.post(`${P}/${po._id}/status`, { status: "received" })).status).toBe(200);
  });

  test("[RECORD] no Cloudinary + live integration + no BACKEND_PUBLIC_URL -> 500 'File hosting is not set up'", async () => {
    S.cloudState.url = "/uploads/123-po.pdf";
    try {
      const po = await poAt("approved");
      const r = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
      expect(r.status).toBe(500);
      expect(r.body.message).toMatch(/BACKEND_PUBLIC_URL/);
      process.env.BACKEND_PUBLIC_URL = "https://crm.example.invalid/";
      const n = S.rec.whatsapp.length;
      const ok = await A.users.maker.api.upload(`${P}/${po._id}/whatsapp`, { file: PDF, fields: { to: "9123456789" } });
      expect(ok.status).toBe(200);
      expect(S.rec.whatsapp.slice(n).find((c) => c.fn.startsWith("send")).url).toBe("https://crm.example.invalid/uploads/123-po.pdf");
    } finally {
      S.cloudState.url = "https://files.test.invalid/po.pdf";
      delete process.env.BACKEND_PUBLIC_URL;
    }
  });
});
