// PART 3 — Approval workflow (submit / approve / reject / pending list / socket event).
// "[BUG]" / "[RECORD]" / "[QUESTION]" tests assert the CURRENT behaviour.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const mongoose = require("mongoose");
const S = require("./poStack.cjs");
const { computeLine, lineBreaches } = require("../../services/purchaseOrderRules");

jest.setTimeout(120000);
const P = S.PO_PATH;
let A, B, creatorOnly;
const Item = () => require("../../models/PoItem");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const ActivityLog = () => require("../../models/ActivityLog");
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const purchase = (it, qty = 1, extra = {}) => ({ type: "purchase", division: "brady", items: [S.line(it, qty, extra)] });
const ioSince = (n) => S.rec.io.slice(n);

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
  const id = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection("staffs").insertOne({ _id: id, firstname: "creatorOnly", lastname: "A", email: "creator.a@crm-test.local", password: "x", active: true, tenant_id: A.tenantId, admin: false, permissions: { "Purchase Orders": { "View(Global)": true, Create: true } } });
  creatorOnly = { id, api: S.api(S.sign(id)) };
});

afterAll(async () => {
  console.log("[guard] PART3", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, wa: S.rec.whatsapp.length, cloud: S.rec.cloudinary.length, ioEmits: S.rec.io.length }));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("3.1 UNIT — lineBreaches at the boundaries", () => {
  const PUR = { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true };
  const SAL = { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false };
  const br = (cost, list, selling, rule) => lineBreaches(computeLine({ name: "x", qty: 1, cost_price: cost, list_price: list, selling_price: selling, tax_rate: 0 }, "purchase"), rule);
  test.each([
    ["margin 13.00 passes", 87, 100, 100, PUR, 0],
    ["margin 12.99 fails", 87.01, 100, 100, PUR, 1],
    ["discount 25.00 passes", 50, 100, 75, PUR, 0],
    ["discount 25.01 fails", 50, 100, 74.99, PUR, 1],
    ["selling = list passes (sales)", 50, 100, 100, SAL, 0],
    ["selling = list - 0.01 fails (sales)", 50, 100, 99.99, SAL, 1],
    ["missing cost fails margin rule (finding 3b)", 0, 100, 100, PUR, 1],
    ["missing cost + no margin rule passes (sales)", 0, 100, 100, SAL, 0],
    ["list 0: discount + below-list checks skipped", 50, 0, 10, { ...PUR, min_margin_pct: null, allow_below_list: false }, 0],
    ["all rules null = no checks", 0, 100, 1, { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: true }, 0],
    ["margin + discount both broken = 2 reasons", 99, 200, 100, PUR, 2],
  ])("%s", (_n, cost, list, selling, rule, n) => {
    expect(br(cost, list, selling, rule)).toHaveLength(n);
  });
  test("[RECORD] margin rule 0 still flags negative margin (selling below cost)", () => {
    expect(br(100, 0, 90, { ...PUR, min_margin_pct: 0 })).toHaveLength(1);
  });
});

describe("3.2 POSITIVE", () => {
  // R4 (round 28): there is no "approved at once" any more.
  test("in-rule PO (every line at list, margin ok) -> STILL pending; approvers notified; nothing to point out", async () => {
    const good = await Item().create({ name: "Good Margin Item", item_code: "GOOD-A", tenant_id: A.tenantId, master_price: 100, end_customer_price: 160, tax_rate: 18 });
    const n = S.rec.io.length;
    const r = await A.users.maker.api.post(P, { ...purchase(good, 1), submit: true });
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval).toMatchObject({ required: true, reasons: [] });
    expect(r.body.approval.decision).toBeUndefined();
    expect(r.body.history.map((h) => h.action)).toEqual(["created", "submitted"]);
    expect(ioSince(n).map((e) => e.payload.event)).toContain("requested");
  });

  test("raised price by maker -> pending; approvers get socket 'requested' (finding 3c recipients)", async () => {
    const n = S.rec.io.length;
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.reasons.join(" ")).toMatch(/Price raised from 160 to 175/);
    const ev = ioSince(n);
    const rooms = ev.map((e) => e.room).sort();
    const U = A.users;
    const expected = [U.admin, U.approver, U.ownApprover, U.roleApprover].map((u) => String(u.id)).sort();
    expect(rooms).toEqual(expected);
    // excluded: submitter, inactive approver, staff-level Approve:false over role, viewers
    [U.maker, U.inactiveApprover, U.roleApproverDenied, U.viewer, U.pricer].forEach((u) => expect(rooms).not.toContain(String(u.id)));
    expect(ev[0]).toMatchObject({ event: "purchaseOrderApproval", payload: { event: "requested", number: r.body.po_number, by: "maker A" } });
    // Tenant B staff never notified
    Object.values(B.users).forEach((u) => expect(rooms).not.toContain(String(u.id)));
  });

  test("approver Yes -> approved; maker gets 'approved' event; history + Activity Log", async () => {
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    const n = S.rec.io.length;
    const a = await A.users.approver.api.post(`${P}/${r.body._id}/approve`, {});
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("approved");
    expect(a.body.approval).toMatchObject({ decision: "approved", decided_by: String(A.users.approver.id) });
    expect(ioSince(n)).toEqual([{ room: String(A.users.maker.id), event: "purchaseOrderApproval", payload: { event: "approved", poId: String(r.body._id), number: r.body.po_number, by: "approver A" } }]);
    const rows = await waitFor(async () => { const x = await ActivityLog().find({ rel_id: r.body._id }).lean(); return x.length >= 3 ? x : null; });
    expect(rows.map((x) => x.description).sort()).toEqual([`Purchase PO ${r.body.po_number} approved`, `Purchase PO ${r.body.po_number} created`, `Purchase PO ${r.body.po_number} sent for approval`].sort());
  });

  test("approver No with reason -> draft; reason saved; maker event; edit + resubmit", async () => {
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    const n = S.rec.io.length;
    const x = await A.users.roleApprover.api.post(`${P}/${r.body._id}/reject`, { reason: "  Margin too low  " });
    expect(x.status).toBe(200);
    expect(x.body.status).toBe("draft");
    expect(x.body.approval).toMatchObject({ decision: "rejected", reason: "Margin too low" });
    expect(ioSince(n)[0]).toMatchObject({ room: String(A.users.maker.id), payload: { event: "rejected", reason: "Margin too low" } });
    const rows = await waitFor(async () => (await ActivityLog().findOne({ rel_id: r.body._id, description: /rejected/ }).lean()));
    expect(rows.description).toBe(`Purchase PO ${r.body.po_number} rejected — Margin too low`);
    // maker edits and resubmits -> waits for the approver again (R4)
    const e = await A.users.maker.api.put(`${P}/${r.body._id}`, { ...purchase(A.items.I1, 1, { selling_price: 160 }), submit: true });
    expect(e.body.status).toBe("pending_approval");
    expect(e.body.history.map((h) => h.action)).toEqual(["created", "submitted", "rejected", "edited", "submitted"]);
  });

  test("submit endpoint on a saved draft works; price change in master between create and submit changes the verdict", async () => {
    const it = await Item().create({ name: "Verdict Item", tenant_id: A.tenantId, cost_price: 100, end_customer_price: 160 });
    const d = await A.users.maker.api.post(P, purchase(it, 1));
    expect(d.body.approval).toMatchObject({ required: true, reasons: [] });
    await Item().updateOne({ _id: it._id }, { cost_price: 150 });
    const s = await A.users.maker.api.post(`${P}/${d.body._id}/submit`, {});
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("pending_approval");
    expect(s.body.items[0].cost_price).toBe(150);
    expect(s.body.approval.reasons.join(" ")).toMatch(/Margin 6.25% is below the 13% minimum/);
  });

  test("pending list: approver sees only pending POs of own company, oldest request first", async () => {
    const r = await A.users.approver.api.get(`${P}/approvals/pending`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((p) => p.status === "pending_approval" && String(p.tenant_id) === String(A.tenantId))).toBe(true);
    const times = r.body.map((p) => new Date(p.approval.requested_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test("role-based approver (role permission only) can approve", async () => {
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    expect((await A.users.roleApprover.api.post(`${P}/${r.body._id}/approve`, {})).status).toBe(200);
  });

  test("View(Own)-only creator can submit own draft (no Edit cap needed)", async () => {
    const d = await A.users.own.api.post(P, purchase(A.items.I1, 1));
    const s = await A.users.own.api.post(`${P}/${d.body._id}/submit`, {});
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("pending_approval");
  });
});

describe("3.3 NEGATIVE", () => {
  let pending, draft, approved;
  beforeAll(async () => {
    pending = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
    draft = (await A.users.maker.api.post(P, purchase(A.items.I1, 1))).body;
    const sub = (await A.users.admin.api.post(P, { ...purchase(A.items.I1, 1), submit: true })).body;
    approved = (await A.users.admin.api.post(`${P}/${sub._id}/approve`, {})).body;
  });
  test("approve / reject a draft or approved PO -> 400", async () => {
    const ap = A.users.approver.api;
    for (const po of [draft, approved]) {
      expect((await ap.post(`${P}/${po._id}/approve`, {})).status).toBe(400);
      expect((await ap.post(`${P}/${po._id}/reject`, { reason: "x" })).status).toBe(400);
    }
  });
  test("reject without reason / '   ' -> 400", async () => {
    const ap = A.users.approver.api;
    expect((await ap.post(`${P}/${pending._id}/reject`, {})).status).toBe(400);
    expect((await ap.post(`${P}/${pending._id}/reject`, { reason: "   " })).status).toBe(400);
  });
  test("maker (no Approve) /approve and /reject -> 403; viewer -> 403", async () => {
    expect((await A.users.maker.api.post(`${P}/${pending._id}/approve`, {})).status).toBe(403);
    expect((await A.users.maker.api.post(`${P}/${pending._id}/reject`, { reason: "x" })).status).toBe(403);
    expect((await A.users.viewer.api.post(`${P}/${pending._id}/approve`, {})).status).toBe(403);
  });
  test("staff-level Approve:false overrides the role's Approve:true -> 403", async () => {
    expect((await A.users.roleApproverDenied.api.post(`${P}/${pending._id}/approve`, {})).status).toBe(403);
  });
  test("submit a pending / approved PO -> 400", async () => {
    expect((await A.users.maker.api.post(`${P}/${pending._id}/submit`, {})).status).toBe(400);
    expect((await A.users.admin.api.post(`${P}/${approved._id}/submit`, {})).status).toBe(400);
  });
  test("submit someone else's draft with Create only -> 403; viewer -> 403", async () => {
    expect((await creatorOnly.api.post(`${P}/${draft._id}/submit`, {})).status).toBe(403);
    expect((await A.users.viewer.api.post(`${P}/${draft._id}/submit`, {})).status).toBe(403);
  });
  test("approve / reject / submit a Tenant B PO -> 404, B unchanged", async () => {
    const bp = (await B.users.maker.api.post(P, { ...purchase(B.items.I1, 1, { selling_price: 175 }), submit: true })).body;
    expect(bp.status).toBe("pending_approval");
    expect((await A.users.approver.api.post(`${P}/${bp._id}/approve`, {})).status).toBe(404);
    expect((await A.users.admin.api.post(`${P}/${bp._id}/reject`, { reason: "x" })).status).toBe(404);
    expect((await A.users.admin.api.post(`${P}/${bp._id}/submit`, {})).status).toBe(404);
    expect((await PurchaseOrder().findById(bp._id).lean()).status).toBe("pending_approval");
    const list = await A.users.approver.api.get(`${P}/approvals/pending`);
    expect(list.body.some((p) => String(p._id) === String(bp._id))).toBe(false);
  });
  // Race tests: 15 rounds each. decide() reads status, then saves without an
  // atomic "status still pending" check (controller 441-472).
  const race = async (second) => {
    const out = { rounds: 0, bothOk: 0, doubleHistory: 0, finals: {}, loserCodes: {} };
    for (let i = 0; i < 15; i++) {
      const r = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
      const [x, y] = await Promise.all([
        A.users.approver.api.post(`${P}/${r._id}/approve`, {}),
        second(r._id),
      ]);
      const db = await PurchaseOrder().findById(r._id).lean();
      const decisions = db.history.filter((h) => ["approved", "rejected"].includes(h.action)).length;
      out.rounds += 1;
      if (x.status === 200 && y.status === 200) out.bothOk += 1;
      if (decisions > 1) out.doubleHistory += 1;
      const ok = [x, y].filter((q) => q.status === 200);
      [x, y].filter((q) => q.status !== 200).forEach((q) => { out.loserCodes[q.status] = (out.loserCodes[q.status] || 0) + 1; });
      // the stored decision must be the one that answered 200
      if (ok.length === 1) out.winnerMatches = (out.winnerMatches || 0) + (ok[0].body.status === db.status && ok[0].body.approval.decision === db.approval.decision ? 1 : 0);
      out.finals[db.status] = (out.finals[db.status] || 0) + 1;
    }
    return out;
  };
  test("[FIXED] double click Yes (two parallel approves): exactly one 200, the other 409/400, history has ONE 'approved'", async () => {
    const out = await race((id) => A.users.admin.api.post(`${P}/${id}/approve`, {}));
    console.log("[record] parallel approve x15 ->", JSON.stringify(out));
    expect(out.finals).toEqual({ approved: 15 });
    expect(out.bothOk).toBe(0);
    expect(out.doubleHistory).toBe(0);
    expect(Object.keys(out.loserCodes).every((c) => ["409", "400"].includes(c))).toBe(true);
    expect(Object.values(out.loserCodes).reduce((s, n) => s + n, 0)).toBe(15);
  });
  test("[FIXED] approve + reject at the same time: exactly one 200, history keeps ONE decision, stored state = the winner's", async () => {
    const out = await race((id) => A.users.admin.api.post(`${P}/${id}/reject`, { reason: "no" }));
    console.log("[record] parallel approve+reject x15 ->", JSON.stringify(out));
    expect(out.bothOk).toBe(0);
    expect(out.doubleHistory).toBe(0);
    expect(out.winnerMatches).toBe(15);
    expect(Object.keys(out.loserCodes).every((c) => ["409", "400"].includes(c))).toBe(true);
  });
  test("409 message text for the losing save", async () => {
    let seen = null;
    for (let i = 0; i < 10 && !seen; i++) {
      const r = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
      const rs = await Promise.all([A.users.approver.api.post(`${P}/${r._id}/approve`, {}), A.users.admin.api.post(`${P}/${r._id}/approve`, {})]);
      seen = rs.find((q) => q.status === 409) || null;
    }
    console.log("[record] 409 seen:", !!seen);
    if (seen) expect(seen.body.message).toBe("Someone else changed this PO just now. Reload it and try again.");
  });
  test("a single approve still works after the concurrency fix (200, one history entry)", async () => {
    const r = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
    const a = await A.users.approver.api.post(`${P}/${r._id}/approve`, {});
    expect(a.status).toBe(200);
    expect(a.body.history.filter((h) => h.action === "approved")).toHaveLength(1);
  });
  test("[FIXED] reject reason as an object -> 400 'Please give a reason for saying No'", async () => {
    const r = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
    for (const reason of [{ a: 1 }, ["x"], 5]) {
      const x = await A.users.approver.api.post(`${P}/${r._id}/reject`, { reason });
      expect(x.status).toBe(400);
      expect(x.body.message).toBe("Please give a reason for saying No");
    }
    expect((await PurchaseOrder().findById(r._id).lean()).status).toBe("pending_approval");
  });
  test("[RECORD] after a concurrency fix: two different PO edits in parallel by the maker -> one 409?", async () => {
    const d = (await A.users.maker.api.post(P, purchase(A.items.I1, 1))).body;
    const rs = await Promise.all([
      A.users.maker.api.put(`${P}/${d._id}`, purchase(A.items.I1, 2)),
      A.users.maker2.api.put(`${P}/${d._id}`, purchase(A.items.I1, 3)),
    ]);
    const db = await PurchaseOrder().findById(d._id).lean();
    console.log("[record] parallel edits ->", rs.map((q) => q.status), "final qty", db.items[0].qty, "history", db.history.map((h) => h.action));
    expect(rs.map((q) => q.status)).toContain(200);
  });
  test("[RECORD] reject reason with HTML stored raw (XSS probe for the History panel)", async () => {
    const r = (await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true })).body;
    const probe = "<img src=x onerror=\"window.__xss=(window.__xss||0)+1\">";
    const x = await A.users.approver.api.post(`${P}/${r._id}/reject`, { reason: probe });
    expect(x.body.approval.reason).toBe(probe);
  });
});

describe("FINDINGS", () => {
  // Answered in round 28 (R4 + Q7): no self-approval on submit. The approver
  // who made the PO may approve it, but only by pressing Yes afterwards.
  test("[FIXED] 3a: an approver's own PO is NOT approved on submit; other approvers are told; Yes by the maker-approver works", async () => {
    const r = await A.users.approver.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 176 }), submit: true });
    // approver has no Create cap -> cannot create; use ownApprover (Create+Approve)
    expect(r.status).toBe(403);
    const n = S.rec.io.length;
    const s = await A.users.ownApprover.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 176 }), submit: true });
    expect(s.body.status).toBe("pending_approval");
    expect(s.body.approval.decision).toBeUndefined();
    expect(s.body.approval.reasons.length).toBeGreaterThan(0);
    const rooms = ioSince(n).map((e) => e.room);
    expect(rooms).toContain(String(A.users.approver.id));
    expect(rooms).not.toContain(String(A.users.ownApprover.id));
    const yes = await A.users.ownApprover.api.post(`${P}/${s.body._id}/approve`, {});
    expect(yes.status).toBe(200);
    expect(yes.body.approval).toMatchObject({ decision: "approved", decided_by: String(A.users.ownApprover.id) });
  });

  test("3b: missing cost price always needs approval on a purchase PO (margin rule on)", async () => {
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I2, 1), submit: true });
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approval.reasons[0]).toMatch(/Cost price not set/);
  });

  // R1: Sales PO was removed — the old "sales PO without margin rule" case can't happen.
  test("[REVERSED R1] 3b: a Sales PO can't be made any more -> 400", async () => {
    const r = await A.users.maker.api.post(P, { type: "sales", division: "brady", customer: String(A.customers.c1._id), items: [S.line(A.items.I2, 1)], submit: true });
    expect(r.status).toBe(400);
  });

  test("3c: admins always approvers even with no PO permission; noAccess never", async () => {
    const n = S.rec.io.length;
    await A.users.maker2.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    const rooms = ioSince(n).map((e) => e.room);
    expect(rooms).toContain(String(A.users.admin.id));
    expect(rooms).toContain(String(A.users.approver.id));
    expect(rooms).not.toContain(String(A.users.maker2.id));
    expect(rooms).not.toContain(String(A.users.noAccess.id));
  });

  test("3d: rule_snapshot keeps the old values after a settings change; resubmit re-snapshots", async () => {
    const r = await A.users.maker.api.post(P, purchase(A.items.I1, 1));
    expect(r.body.rule_snapshot.min_margin_pct).toBe(13);
    const s = (await A.users.admin.api.get(`${P}/settings`)).body;
    await A.users.admin.api.put(`${P}/settings`, { rules: { purchase: { ...s.rules.purchase, min_margin_pct: 50 } } });
    const g = await A.users.maker.api.get(`${P}/${r.body._id}`);
    expect(g.body.rule_snapshot.min_margin_pct).toBe(13);
    const sub = await A.users.maker.api.post(`${P}/${r.body._id}/submit`, {});
    expect(sub.body.rule_snapshot.min_margin_pct).toBe(50);
    expect(sub.body.status).toBe("pending_approval"); // always (R4); 6.25% < 50% under the NEW rule
    expect(sub.body.approval.reasons.join(" ")).toMatch(/below the 50% minimum/);
    await A.users.admin.api.put(`${P}/settings`, { rules: { purchase: s.rules.purchase } });
  });

  test("[RECORD] View(Own)+Approve staff can open and approve any PO (scope widened by Approve)", async () => {
    const r = await A.users.maker.api.post(P, { ...purchase(A.items.I1, 1, { selling_price: 175 }), submit: true });
    expect((await A.users.ownApprover.api.get(`${P}/${r.body._id}`)).status).toBe(200);
    expect((await A.users.ownApprover.api.post(`${P}/${r.body._id}/approve`, {})).status).toBe(200);
  });
});
