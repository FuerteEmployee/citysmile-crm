// PART 1 — Orders list + summary cards (GET /, GET /stats, DELETE /:id).
// Convention for the whole PO suite: tests named "[BUG] ..." / "[RECORD] ..."
// assert the ACTUAL (current) behaviour so the suite stays green; the name says
// what is wrong. All other tests assert the correct behaviour.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const mongoose = require("mongoose");
const S = require("./poStack.cjs");

jest.setTimeout(120000);
const P = S.PO_PATH;
let A, B;
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
const year = new Date().getFullYear();
const fy = S.fyNow();

// Fixtures created through the API
const made = {};
const create = async (u, body) => {
  const r = await u.api.post(P, body);
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B");
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;

  const { users: u, items: it, customers: c } = A;
  made.pDraft = await create(u.maker, { type: "purchase", division: "brady", items: [S.line(it.I1, 2)] });
  // R1: Sales PO can't be made through the API any more — an OLD sales record
  // is put in the (in-memory) DB, the way it was stored before.
  made.sDraft = (await S.insertSalesPo(A, {
    number: "SPO-2025-0001",
    customer: c.c1,
    items: [{ item_id: it.I5._id, item_code: it.I5.item_code, name: it.I5.name, qty: 3, cost_price: 50, list_price: 70, selling_price: 80, rate: 80, tax_rate: 0, amount: 240, tax_amount: 0 }],
  })).toJSON();
  // R4: every PO waits for a Yes — admin's own POs are approved by the admin.
  const adminApproved = (division, items) => S.approvedPo(A, items, { division }, { maker: "admin", approver: "admin" });
  made.spkApproved = await adminApproved("sparkling", [S.line(it.I1, 1)]);
  made.ownDraft = await create(u.own, { type: "purchase", division: "brady", items: [S.line(it.I6, 4)] });
  made.pending = await create(u.maker, { type: "purchase", division: "brady", items: [S.line(it.I2, 1)], submit: true }); // no cost -> pending
  // a sent and a received PO
  made.sent = await adminApproved("brady", [S.line(it.I1, 1)]);
  await u.admin.api.post(`${P}/${made.sent._id}/status`, { status: "sent" });
  made.received = await adminApproved("brady", [S.line(it.I1, 1)]);
  await u.admin.api.post(`${P}/${made.received._id}/status`, { status: "sent" });
  await u.admin.api.post(`${P}/${made.received._id}/status`, { status: "received" });
  // Tenant B data that must never show in A
  made.bPo = await create(B.users.admin, { type: "purchase", division: "brady", items: [S.line(B.items.I1, 1)] });
});

afterAll(async () => {
  console.log("[guard] PART1", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, wa: S.rec.whatsapp.length, cloud: S.rec.cloudinary.length }));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("1.1 UNIT", () => {
  test("search escapes regex characters '(' '[' '.*' (no 500, literal match)", async () => {
    for (const s of ["(", "[", ".*", "\\", "+?", "$"]) {
      const r = await A.users.admin.api.get(`${P}?search=${encodeURIComponent(s)}`);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(0); // nothing literally contains these
    }
  });

  test("scopeFilter: global viewer sees all A POs, View(Own) sees only own", async () => {
    const all = await A.users.viewer.api.get(`${P}?limit=500`);
    const own = await A.users.own.api.get(`${P}?limit=500`);
    expect(all.body.total).toBe(7);
    expect(own.body.total).toBe(1);
    expect(String(own.body.data[0]._id)).toBe(String(made.ownDraft._id));
  });

  test("scopeFilter: View(Own) + Approve sees every PO (finding 1e)", async () => {
    const r = await A.users.ownApprover.api.get(`${P}?limit=500`);
    expect(r.body.total).toBe(7);
  });

  test("stats: grouped by status, value = round2(sum grand_total)", async () => {
    const r = await A.users.admin.api.get(`${P}/stats`);
    expect(r.status).toBe(200);
    const docs = await PurchaseOrder().find({ tenant_id: A.tenantId }).lean();
    const exp = {};
    docs.forEach((d) => {
      exp[d.status] = exp[d.status] || { count: 0, value: 0 };
      exp[d.status].count += 1;
      exp[d.status].value += d.totals.grand_total;
    });
    Object.values(exp).forEach((v) => { v.value = Math.round(v.value * 100) / 100; });
    expect(r.body.byStatus).toEqual(exp);
  });
});

describe("1.2 POSITIVE", () => {
  test("filter type / division / status alone and combined", async () => {
    const a = A.users.admin.api;
    expect((await a.get(`${P}?type=sales`)).body.total).toBe(1);
    expect((await a.get(`${P}?division=sparkling`)).body.total).toBe(1);
    expect((await a.get(`${P}?status=draft`)).body.total).toBe(3);
    expect((await a.get(`${P}?type=purchase&division=brady&status=draft`)).body.total).toBe(2);
    expect((await a.get(`${P}?type=purchase&status=approved`)).body.total).toBe(1);
  });

  test("from / to date filters (to includes the whole day)", async () => {
    const a = A.users.admin.api;
    const today = new Date().toISOString().slice(0, 10);
    expect((await a.get(`${P}?from=${today}&to=${today}`)).body.total).toBe(7);
    expect((await a.get(`${P}?from=${year + 1}-01-01`)).body.total).toBe(0);
    expect((await a.get(`${P}?to=${year - 1}-12-31`)).body.total).toBe(0);
  });

  test("search by PO number, customer name, item name, item code (case-insensitive)", async () => {
    const a = A.users.admin.api;
    expect((await a.get(`${P}?search=${made.sDraft.po_number}`)).body.total).toBe(1);
    expect((await a.get(`${P}?search=acme a`)).body.total).toBe(1);
    expect((await a.get(`${P}?search=i6 twotax`)).body.total).toBe(1);
    expect((await a.get(`${P}?search=br-001`)).body.total).toBe(1);
    expect((await a.get(`${P}?search=%20%20`)).body.total).toBe(7); // blank search = no filter
  });

  test("paging: limit / page / pages", async () => {
    const a = A.users.admin.api;
    const p1 = await a.get(`${P}?limit=3&page=1`);
    const p3 = await a.get(`${P}?limit=3&page=3`);
    expect(p1.body).toMatchObject({ total: 7, page: 1, pages: 3, limit: 3 });
    expect(p1.body.data).toHaveLength(3);
    expect(p3.body.data).toHaveLength(1);
    const ids = new Set([...(p1.body.data), ...(await a.get(`${P}?limit=3&page=2`)).body.data, ...p3.body.data].map((d) => d._id));
    expect(ids.size).toBe(7);
  });

  test("list rows hide history / whatsapp_log / rule_snapshot", async () => {
    const r = await A.users.admin.api.get(`${P}?limit=1`);
    expect(r.body.data[0].history).toBeUndefined();
    expect(r.body.data[0].whatsapp_log).toBeUndefined();
    expect(r.body.data[0].rule_snapshot).toBeUndefined();
  });

  test("stats counts match list counts per status, type filter applied", async () => {
    const a = A.users.admin.api;
    const stats = (await a.get(`${P}/stats`)).body.byStatus;
    for (const [status, { count }] of Object.entries(stats)) {
      expect((await a.get(`${P}?status=${status}`)).body.total).toBe(count);
    }
    const salesStats = (await a.get(`${P}/stats?type=sales`)).body.byStatus;
    expect(salesStats).toEqual({ draft: { count: 1, value: made.sDraft.totals.grand_total } });
  });

  test("delete a draft and a cancelled PO", async () => {
    const a = A.users.admin.api;
    const d = await create(A.users.maker, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] });
    const c = await create(A.users.maker, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] });
    expect((await a.post(`${P}/${c._id}/status`, { status: "cancelled" })).status).toBe(200);
    expect((await A.users.full.api.del(`${P}/${d._id}`)).status).toBe(200);
    expect((await A.users.full.api.del(`${P}/${c._id}`)).status).toBe(200);
    expect(await PurchaseOrder().countDocuments({ _id: { $in: [d._id, c._id] } })).toBe(0);
  });
});

describe("1.3 NEGATIVE", () => {
  test("delete approved / sent / received / pending -> 400 (finding 1d)", async () => {
    const a = A.users.admin.api;
    for (const po of [made.spkApproved, made.sent, made.received, made.pending]) {
      const r = await a.del(`${P}/${po._id}`);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/Only draft or cancelled/);
    }
  });

  test("delete unknown id / invalid id -> 404", async () => {
    const a = A.users.admin.api;
    expect((await a.del(`${P}/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await a.del(`${P}/not-an-id`)).status).toBe(404);
  });

  test("delete without Delete cap -> 403 (maker has Create+Edit only)", async () => {
    const r = await A.users.maker.api.del(`${P}/${made.pDraft._id}`);
    expect(r.status).toBe(403);
  });

  test("limit clamp: 100000 -> 500, -5 -> 1, 'abc' -> 25; page <1 -> 1 (finding 1c)", async () => {
    const a = A.users.admin.api;
    expect((await a.get(`${P}?limit=100000`)).body.limit).toBe(500);
    expect((await a.get(`${P}?limit=-5`)).body.limit).toBe(1);
    expect((await a.get(`${P}?limit=abc`)).body.limit).toBe(25);
    expect((await a.get(`${P}?page=-3`)).body.page).toBe(1);
    expect((await a.get(`${P}?page=0`)).body.page).toBe(1);
    expect((await a.get(`${P}?page=abc`)).body.page).toBe(1);
  });

  test("[RECORD] limit=0 gives the default 25 (0 is falsy), not 1", async () => {
    expect((await A.users.admin.api.get(`${P}?limit=0`)).body.limit).toBe(25);
  });

  test("page far past the end -> 200 empty data", async () => {
    const r = await A.users.admin.api.get(`${P}?page=999999`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });

  test("[RECORD] page=1e20 (huge) -> status recorded", async () => {
    const r = await A.users.admin.api.get(`${P}?page=100000000000000000000`);
    console.log("[record] page=1e20 ->", r.status, r.body && r.body.message);
    expect([200, 500]).toContain(r.status);
  });

  test("[FIXED] from=abc / to=not-a-date (invalid date) -> 400 (finding 1b)", async () => {
    const r = await A.users.admin.api.get(`${P}?from=abc`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("From date is not a valid date");
    const r2 = await A.users.admin.api.get(`${P}?to=not-a-date`);
    expect(r2.status).toBe(400);
    expect(r2.body.message).toBe("To date is not a valid date");
    expect((await A.users.admin.api.get(`${P}?from[$gt]=x`)).status).toBe(400);
  });

  test("to < from -> 200, empty", async () => {
    const r = await A.users.admin.api.get(`${P}?from=${year}-12-31&to=${year}-01-01`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
  });

  test("[FIXED] status[$ne]=draft operator injection -> 400 'Invalid status filter' (finding 1a)", async () => {
    const r = await A.users.admin.api.get(`${P}?status[$ne]=draft&limit=500`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Invalid status filter");
  });

  test("[FIXED] type[$in][]=sales operator injection -> 400 'Invalid type filter' (finding 1a)", async () => {
    const r = await A.users.admin.api.get(`${P}?type[$in][]=sales`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Invalid type filter");
  });

  test("[FIXED] status[$regex]=. / division[$exists]=true -> 400", async () => {
    const a = A.users.admin.api;
    const s = await a.get(`${P}?status[$regex]=.`);
    expect(s.status).toBe(400);
    const d = await a.get(`${P}?division[$exists]=true`);
    expect(d.status).toBe(400);
    expect(d.body.message).toBe("Invalid division filter");
  });

  test("query tenant_id / created_by are ignored: stays inside the company and inside View(Own) scope", async () => {
    // tenant_id / created_by are set by scopeFilter and cannot be overridden by query.
    const a = A.users.admin.api;
    const r = await a.get(`${P}?tenant_id=${B.tenantId}&limit=500`);
    expect(r.body.data.some((p) => String(p._id) === String(made.bPo._id))).toBe(false);
    const own = await A.users.own.api.get(`${P}?created_by=${A.users.maker.id}`);
    expect(own.body.total).toBe(1);
  });

  test("[FIXED] stats ?type[$ne]=x -> 400; stats ?type=xyz -> 400; valid type/division still filter", async () => {
    const a = A.users.admin.api;
    expect((await a.get(`${P}/stats?type[$ne]=x`)).status).toBe(400);
    expect((await a.get(`${P}/stats?division[$ne]=x`)).status).toBe(400);
    expect((await a.get(`${P}/stats?type=xyz`)).status).toBe(400);
    const ok = await a.get(`${P}/stats?type=purchase&division=brady`);
    expect(ok.status).toBe(200);
    expect(Object.values(ok.body.byStatus).reduce((s, v) => s + v.count, 0)).toBe(5);
  });

  test("[RECORD] unknown operator status[$foo]=1 -> status recorded", async () => {
    const r = await A.users.admin.api.get(`${P}?status[$foo]=1`);
    console.log("[record] status[$foo] ->", r.status, r.body && r.body.message);
    expect([200, 400, 500]).toContain(r.status);
  });

  test("repeated param type=purchase&type=sales (array) -> 400 'Invalid type filter'", async () => {
    const r = await A.users.admin.api.get(`${P}?type=purchase&type=sales`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Invalid type filter");
  });

  test("type 'other' -> 400; empty filters (type=&status=) are ignored", async () => {
    const a = A.users.admin.api;
    expect((await a.get(`${P}?type=other`)).status).toBe(400);
    const r = await a.get(`${P}?type=&status=&division=`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(7);
  });

  test("search 10,000 chars -> 200, no match; search as array/object is ignored", async () => {
    const a = A.users.admin.api;
    const r = await a.get(`${P}?search=${"x".repeat(10000)}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    const arr = await a.get(`${P}?search[]=a&search[]=b`);
    expect(arr.status).toBe(200);
    expect(arr.body.total).toBe(7);
    const obj = await a.get(`${P}?search[$ne]=zz`);
    expect(obj.status).toBe(200);
    expect(obj.body.total).toBe(7);
  });

  test("unknown status value -> 400 'Invalid status filter'", async () => {
    const r = await A.users.admin.api.get(`${P}?status=xyz`);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Invalid status filter");
  });
});

describe("1.5 INTEGRATION", () => {
  test("create via API -> list + stats change by 1 and by its grand total", async () => {
    const a = A.users.admin.api;
    const before = (await a.get(`${P}/stats`)).body.byStatus.draft;
    const po = await create(A.users.maker, { type: "purchase", division: "brady", items: [S.line(A.items.I4, 2)] });
    const after = (await a.get(`${P}/stats`)).body.byStatus.draft;
    expect(after.count).toBe(before.count + 1);
    expect(after.value).toBeCloseTo(before.value + po.totals.grand_total, 2);
    expect((await a.get(`${P}?search=${po.po_number}`)).body.total).toBe(1);
    // delete -> gone from list, stats, DB
    expect((await a.del(`${P}/${po._id}`)).status).toBe(200);
    expect((await a.get(`${P}/stats`)).body.byStatus.draft).toEqual(before);
    expect((await a.get(`${P}?search=${po.po_number}`)).body.total).toBe(0);
    expect(await PurchaseOrder().findById(po._id)).toBeNull();
  });

  test("create and delete each write an Activity Log row (rel_type purchase_order)", async () => {
    const po = await create(A.users.maker, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] });
    await A.users.admin.api.del(`${P}/${po._id}`);
    const rows = await waitFor(async () => {
      const r = await ActivityLog().find({ rel_id: po._id }).lean();
      return r.length >= 2 ? r : null;
    });
    expect(rows).not.toBeNull();
    const desc = rows.map((r) => r.description);
    expect(desc).toContain(`Purchase PO ${po.po_number} created`);
    expect(desc).toContain(`Purchase PO ${po.po_number} deleted`);
    rows.forEach((r) => {
      expect(r.rel_type).toBe("purchase_order");
      expect(String(r.tenant_id)).toBe(String(A.tenantId));
    });
  });

  test("list never includes Tenant B POs; stats never count them", async () => {
    const r = await A.users.admin.api.get(`${P}?limit=500`);
    expect(r.body.data.every((p) => String(p.tenant_id) === String(A.tenantId))).toBe(true);
    const bStats = (await B.users.admin.api.get(`${P}/stats`)).body.byStatus;
    expect(bStats).toEqual({ draft: { count: 1, value: made.bPo.totals.grand_total } });
  });

  test("PO numbers are counted per company (A and B both start at 0001)", async () => {
    expect(made.pDraft.po_number).toBe(`PPO/01/${fy}`);
    expect(made.bPo.po_number).toBe(`PPO/01/${fy}`);
  });
});

describe("1.6 PERMISSIONS (API side)", () => {
  test("viewer can list + stats, cannot create / delete", async () => {
    const v = A.users.viewer.api;
    expect((await v.get(P)).status).toBe(200);
    expect((await v.get(`${P}/stats`)).status).toBe(200);
    expect((await v.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).status).toBe(403);
    expect((await v.del(`${P}/${made.pDraft._id}`)).status).toBe(403);
  });

  test("Approvals list only with Approve", async () => {
    expect((await A.users.viewer.api.get(`${P}/approvals/pending`)).status).toBe(403);
    expect((await A.users.maker.api.get(`${P}/approvals/pending`)).status).toBe(403);
    expect((await A.users.approver.api.get(`${P}/approvals/pending`)).status).toBe(200);
  });

  test("View(Own) staff: stats count only own POs", async () => {
    const r = await A.users.own.api.get(`${P}/stats`);
    expect(r.body.byStatus).toEqual({ draft: { count: 1, value: made.ownDraft.totals.grand_total } });
  });

  test("noAccess -> 403 on list", async () => {
    expect((await A.users.noAccess.api.get(P)).status).toBe(403);
  });
});
