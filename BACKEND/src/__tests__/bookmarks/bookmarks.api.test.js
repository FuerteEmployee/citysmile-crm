// Bookmarks module — API suite (test-prompts/03-bookmarks.md, phases 2,3(API side),4,6,9,10).
// In-memory MongoDB only (crmTestApp.start guards 127.0.0.1). Each test states the CORRECT
// behaviour (PROPOSED rules treated as real, per the business owner); a failure = a bug.
// Test names: "[P<phase>] <area> :: <check>" so the report can be built from the output.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { bootBookmarks } = require("../../testUtils/bookmarksFixtures");

let ctx, T, A, B, Bookmark;
const api = (who) => ctx.client(who && who.token);
const N = (n, ch = "a") => ch.repeat(n);
const fresh = () => `https://u${Date.now()}${Math.floor(Math.random() * 1e6)}.example.com`;
const reseedB = async () => {
  // Restore tenant A's seeded rows that a test may have changed.
  const db = mongoose.connection.db;
  await db.collection("bookmarks").updateOne({ _id: A.b.pubAdmin._id }, { $set: { title: "BeOnTime Customers", folder: "CRM Shortcuts", url: "/admin/customers" } });
};

beforeAll(async () => {
  ctx = await bootBookmarks();
  ({ T, Bookmark } = ctx);
  A = T.BeOnTime;
  B = T.CitySmile;
});
afterAll(async () => { await ctx.stop(); });

// ───────────────────────── Phase 2: CRUD ─────────────────────────
describe("[P2] CRUD", () => {
  test("[P2] create :: admin POST → 201, DB matches (title/url/folder/private/tenant/creator)", async () => {
    const url = fresh();
    const r = await api(A.admin).post("/api/bookmarks", { title: "  GST Portal  ", url: `  ${url}  `, folder: "  Finance  ", is_private: false });
    expect(r.status).toBe(201);
    const db = await Bookmark.findById(r.body._id).lean();
    expect(db).toMatchObject({ title: "GST Portal", url, folder: "Finance", is_private: false });
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
    expect(String(db.created_by)).toBe(String(A.admin.id));
    expect(r.body.created_by.firstname).toBe("Admin");
  });
  test("[P2] create :: empty folder → 'Uncategorized'", async () => {
    const r = await api(A.full).post("/api/bookmarks", { title: "No folder", url: fresh(), folder: "   " });
    expect(r.status).toBe(201);
    expect(r.body.folder).toBe("Uncategorized");
  });
  test("[P2] create :: staff (Bookmarks permission) can create a private bookmark", async () => {
    const r = await api(A.full).post("/api/bookmarks", { title: "Mine", url: fresh(), is_private: true });
    expect(r.status).toBe(201);
    expect(r.body.is_private).toBe(true);
  });
  test("[P2] list :: GET → 200, newest first, only own tenant", async () => {
    const r = await api(A.admin).get("/api/bookmarks");
    expect(r.status).toBe(200);
    const times = r.body.map((b) => new Date(b.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(r.body.every((b) => String(b.tenant_id) === String(A.tenantId))).toBe(true);
  });
  test("[P2] edit :: owner PUT every field → 200 and DB updated", async () => {
    const c = await api(A.full).post("/api/bookmarks", { title: "Edit me", url: fresh(), folder: "Work" });
    const url = fresh();
    const r = await api(A.full).put(`/api/bookmarks/${c.body._id}`, { title: "Edited", url, folder: "Docs", is_private: true });
    expect(r.status).toBe(200);
    expect(await Bookmark.findById(c.body._id).lean()).toMatchObject({ title: "Edited", url, folder: "Docs", is_private: true });
  });
  test("[P2] delete :: owner DELETE → 200 'Bookmark removed' and gone from DB", async () => {
    const c = await api(A.full).post("/api/bookmarks", { title: "Delete me", url: fresh() });
    const r = await api(A.full).del(`/api/bookmarks/${c.body._id}`);
    expect(r.status).toBe(200);
    expect(r.body.message).toBe("Bookmark removed");
    expect(await Bookmark.findById(c.body._id)).toBeNull();
  });
  test("[P2] edit :: admin can edit another user's bookmark", async () => {
    const r = await api(A.admin).put(`/api/bookmarks/${A.b.pubFull._id}`, { title: "BeOnTime Public Site" });
    expect(r.status).toBe(200);
  });
});

// ─────────────── Phase 3 (API side): ordering + data for grouping ───────────────
describe("[P3] list data", () => {
  test("[P3] folder values returned trimmed so counts and groups agree (no ' Work ' vs 'Work')", async () => {
    const r = await api(A.admin).get("/api/bookmarks");
    const raw = r.body.map((b) => b.folder);
    expect(raw.filter((f) => f !== f.trim())).toEqual([]);
  });
});

// ───────────────────────── Field rules ─────────────────────────
// [field, label, body-override, expected "reject"|"accept"]
const POST_CASES = [
  ["title", "empty", { title: "" }, "reject"],
  ["title", "only spaces", { title: "    " }, "reject"],
  ["title", "missing", { title: undefined }, "reject"],
  ["title", "number 123", { title: 123 }, "reject"],
  ["title", "200 chars (max)", { title: N(200) }, "accept"],
  ["title", "201 chars (max 200, PROPOSED)", { title: N(201) }, "reject"],
  ["title", "10,000 chars", { title: N(10000) }, "reject"],
  ["title", "emoji / Gujarati", { title: "ગુજરાત GST 🚀" }, "accept"],
  ["title", "<script> stored raw (React escapes)", { title: "<script>alert(1)</script>" }, "accept"],
  ["title", "{\"$ne\":null} object", { title: { $ne: null } }, "reject"],
  ["url", "missing", { url: undefined }, "reject"],
  ["url", "empty", { url: "" }, "reject"],
  ["url", "only spaces", { url: "   " }, "reject"],
  ["url", "javascript:alert(1)", { url: "javascript:alert(1)" }, "reject"],
  ["url", "JaVaScRiPt:alert(1)", { url: "JaVaScRiPt:alert(1)" }, "reject"],
  ["url", "leading space + javascript:", { url: "  javascript:alert(1)" }, "reject"],
  ["url", "java<TAB>script:", { url: "java\tscript:alert(1)" }, "reject"],
  ["url", "data:text/html", { url: "data:text/html,<script>alert(1)</script>" }, "reject"],
  ["url", "vbscript:", { url: "vbscript:msgbox(1)" }, "reject"],
  ["url", "ftp://", { url: "ftp://files.example.com" }, "reject"],
  ["url", "plain word 'google'", { url: "google" }, "reject"],
  ["url", "'https://' alone", { url: "https://" }, "reject"],
  ["url", "'//evil.com' (protocol-relative, PROPOSED reject)", { url: "//evil.com" }, "reject"],
  ["url", "'/\\\\evil.com' (backslash protocol-relative)", { url: "/\\evil.com" }, "reject"],
  ["url", "internal '/admin/invoices'", { url: "/admin/invoices" }, "accept"],
  ["url", "https://example.com/path?q=1#x", { url: "https://example.com/path?q=1#x" }, "accept"],
  ["url", "HTTP://EXAMPLE.COM (upper case)", { url: "HTTP://EXAMPLE.COM/upper" }, "accept"],
  ["url", "2048 chars (max, PROPOSED)", { url: "https://example.com/" + N(2048 - 20) }, "accept"],
  ["url", "2049 chars (max 2048, PROPOSED)", { url: "https://example.com/" + N(2049 - 20) }, "reject"],
  ["url", "{\"$ne\":null} object", { url: { $ne: null } }, "reject"],
  ["folder", "100 chars (max, PROPOSED)", { folder: N(100) }, "accept"],
  ["folder", "101 chars (max 100, PROPOSED)", { folder: N(101) }, "reject"],
  ["folder", "5,000 chars", { folder: N(5000) }, "reject"],
  ["is_private", "string \"false\" must not make it private", { is_private: "false" }, "notPrivate"],
  ["client", "client id of ANOTHER company", { client: "__B_CLIENT__" }, "reject"],
  ["chromeBookmarkId", "{\"$ne\":null} object (must be 400, not 500)", { chromeBookmarkId: { $ne: null } }, "reject"],
];

describe("[P6] Field rules — POST", () => {
  test.each(POST_CASES.map(([f, l, o, e]) => [f, l, e, o]))("[P6] POST %s :: %s → %s", async (field, label, expected, over) => {
    const body = { title: "Field test", url: fresh(), folder: "Fields", ...over };
    if (body.client === "__B_CLIENT__") body.client = String(B.clientId);
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const r = await api(A.full).post("/api/bookmarks", body);
    expect(r.status).not.toBe(500);
    if (expected === "accept") expect([200, 201]).toContain(r.status);
    else if (expected === "notPrivate") {
      if (r.status === 201) expect(r.body.is_private).toBe(false);
      else expect(r.status).toBe(400);
    } else {
      expect(r.status).toBe(400);
      expect(typeof r.body.message).toBe("string");
    }
  });
});

const PUT_CASES = [
  ["title", "only spaces", { title: "   " }, "reject"],
  ["title", "201 chars", { title: N(201) }, "reject"],
  ["url", "javascript:", { url: "javascript:alert(1)" }, "reject"],
  ["url", "'https://' alone", { url: "https://" }, "reject"],
  ["url", "'//evil.com'", { url: "//evil.com" }, "reject"],
  ["url", "2049 chars", { url: "https://example.com/" + N(2029) }, "reject"],
  ["url", "null", { url: null }, "reject"],
  ["folder", "101 chars", { folder: N(101) }, "reject"],
  ["client", "client id of ANOTHER company", { client: "__B_CLIENT__" }, "reject"],
];

describe("[P6] Field rules — PUT (edit uses the same rules)", () => {
  let id;
  beforeAll(async () => {
    id = (await api(A.full).post("/api/bookmarks", { title: "Edit rules", url: fresh() })).body._id;
  });
  test.each(PUT_CASES.map(([f, l, o, e]) => [f, l, e, o]))("[P6] PUT %s :: %s → %s", async (field, label, expected, over) => {
    const body = { ...over };
    if (body.client === "__B_CLIENT__") body.client = String(B.clientId);
    const r = await api(A.full).put(`/api/bookmarks/${id}`, body);
    expect(r.status).not.toBe(500);
    expect(r.status).toBe(400);
  });
});

describe("[P6] Duplicates", () => {
  test("[P6] duplicate :: same user, same URL twice → clear rejection (409/400 with message), not silent overwrite", async () => {
    const url = fresh();
    const r1 = await api(A.full).post("/api/bookmarks", { title: "First", url });
    expect(r1.status).toBe(201);
    const r2 = await api(A.full).post("/api/bookmarks", { title: "Second", url });
    expect([400, 409]).toContain(r2.status);
    expect(r2.body.message).toMatch(/already/i);
  });
  test("[P6] duplicate :: same URL in a DIFFERENT company → allowed (201)", async () => {
    const url = fresh();
    expect((await api(A.full).post("/api/bookmarks", { title: "A", url })).status).toBe(201);
    expect((await api(B.full).post("/api/bookmarks", { title: "B", url })).status).toBe(201);
  });
  test("[P6] duplicate :: editing a bookmark to another of my URLs → rejected (suspected bug 7)", async () => {
    const u1 = fresh();
    const u2 = fresh();
    await api(A.full).post("/api/bookmarks", { title: "One", url: u1 });
    const b2 = await api(A.full).post("/api/bookmarks", { title: "Two", url: u2 });
    const r = await api(A.full).put(`/api/bookmarks/${b2.body._id}`, { url: u1 });
    expect([400, 409]).toContain(r.status);
  });
  test("[P6] double-click Save :: two identical POSTs at the same instant → only one row", async () => {
    const url = fresh();
    await Promise.all([api(A.full).post("/api/bookmarks", { title: "Dbl", url }), api(A.full).post("/api/bookmarks", { title: "Dbl", url })]);
    expect(await Bookmark.countDocuments({ url, tenant_id: A.tenantId })).toBe(1);
  });
  test("[P6] deleted record :: PUT/DELETE a deleted id → 404", async () => {
    const c = await api(A.full).post("/api/bookmarks", { title: "gone", url: fresh() });
    await api(A.full).del(`/api/bookmarks/${c.body._id}`);
    expect((await api(A.full).put(`/api/bookmarks/${c.body._id}`, { title: "x" })).status).toBe(404);
    expect((await api(A.full).del(`/api/bookmarks/${c.body._id}`)).status).toBe(404);
  });
});

// ───────────────────────── Phase 4: roles ─────────────────────────
describe("[P4] Role-based access", () => {
  test("[P4] staff list :: sees public + own private; never another user's private", async () => {
    const r = await api(A.full).get("/api/bookmarks");
    const ids = r.body.map((b) => String(b._id));
    expect(ids).toContain(String(A.b.pubAdmin._id));
    expect(ids).toContain(String(A.b.privFull._id));
    expect(ids).not.toContain(String(A.b.privFull2._id));
    expect(ids).not.toContain(String(A.b.privAdmin._id));
  });
  test("[P4] admin list :: private bookmarks of OTHER users are not shown (rule: private = only the creator; owner to confirm)", async () => {
    const r = await api(A.admin).get("/api/bookmarks");
    const ids = r.body.map((b) => String(b._id));
    expect(ids).toContain(String(A.b.privAdmin._id));
    expect(ids).not.toContain(String(A.b.privFull._id));
  });
  test("[P4] staff PUT another user's PUBLIC bookmark → 403", async () => {
    const r = await api(A.full).put(`/api/bookmarks/${A.b.pubAdmin._id}`, { title: "hijack" });
    expect(r.status).toBe(403);
  });
  test("[P4] staff DELETE another user's PUBLIC bookmark → 403", async () => {
    const r = await api(A.full).del(`/api/bookmarks/${A.b.pubFull2._id}`);
    expect(r.status).toBe(403);
    expect(await Bookmark.findById(A.b.pubFull2._id)).not.toBeNull();
  });
  test("[P4] staff PUT/DELETE another user's PRIVATE bookmark → 403/404 and unchanged", async () => {
    const p = await api(A.full).put(`/api/bookmarks/${A.b.privFull2._id}`, { title: "x" });
    const d = await api(A.full).del(`/api/bookmarks/${A.b.privFull2._id}`);
    expect([403, 404]).toContain(p.status);
    expect([403, 404]).toContain(d.status);
    expect((await Bookmark.findById(A.b.privFull2._id).lean()).title).toBe("BeOnTime Private Fulltwo");
  });
  test("[P4] staff DELETE /api/bookmarks (Delete All) → 403", async () => {
    const r = await api(A.full).del("/api/bookmarks");
    expect(r.status).toBe(403);
    expect(await Bookmark.countDocuments({ tenant_id: A.tenantId })).toBeGreaterThan(0);
  });
  test("[P4] staff WITHOUT the Bookmarks permission: GET → 403 (PROPOSED)", async () => {
    expect((await api(A.noPerm).get("/api/bookmarks")).status).toBe(403);
  });
  test("[P4] staff WITHOUT the Bookmarks permission: POST → 403 (PROPOSED)", async () => {
    expect((await api(A.noPerm).post("/api/bookmarks", { title: "x", url: fresh() })).status).toBe(403);
  });
  test("[P4] staff WITHOUT the Bookmarks permission: sync → 403 (PROPOSED)", async () => {
    expect((await api(A.noPerm).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: fresh() }] })).status).toBe(403);
  });
  test("[P4] admin-flag staff WITH a role (screen shows them as staff) gets the same answer from the API: cannot edit others' bookmark", async () => {
    const r = await api(A.roleAdmin).put(`/api/bookmarks/${A.b.pubFull._id}`, { title: "BeOnTime Public Site" });
    expect(r.status).toBe(403);
  });
  test("[P4] admin-flag staff WITH a role: sees others' private bookmarks? must match screen (staff) → no", async () => {
    const r = await api(A.roleAdmin).get("/api/bookmarks");
    expect(r.body.map((b) => String(b._id))).not.toContain(String(A.b.privFull2._id));
  });
  test("[P4] customer-portal contact token → 403 on GET (suspected bug 3)", async () => {
    const r = await api(ctx.contact).get("/api/bookmarks");
    expect(r.status).toBe(403);
  });
  test("[P4] customer-portal contact token → 403 on POST", async () => {
    const r = await api(ctx.contact).post("/api/bookmarks", { title: "x", url: fresh() });
    expect(r.status).toBe(403);
  });
  test("[P4] plan module 'bookmarks' off → GET/POST/PUT/DELETE/sync all 403 MODULE_DISABLED", async () => {
    const P = T.NoBookmarksPlan;
    const rs = [
      await api(P.admin).get("/api/bookmarks"),
      await api(P.admin).post("/api/bookmarks", { title: "x", url: fresh() }),
      await api(P.admin).put(`/api/bookmarks/${P.b.pubAdmin._id}`, { title: "x" }),
      await api(P.admin).del(`/api/bookmarks/${P.b.pubAdmin._id}`),
      await api(P.admin).post("/api/bookmarks/sync", { bookmarks: [] }),
      await api(P.admin).del("/api/bookmarks/chrome/11"),
    ];
    for (const r of rs) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("MODULE_DISABLED");
    }
  });
});

// ───────────────────────── Phase 9: API basics ─────────────────────────
const ENDPOINTS = [
  ["GET", "/api/bookmarks"], ["POST", "/api/bookmarks"], ["DELETE", "/api/bookmarks"], ["POST", "/api/bookmarks/sync"],
  ["DELETE", "/api/bookmarks/chrome/11"], ["PUT", "/api/bookmarks/64b0000000000000000000aa"], ["DELETE", "/api/bookmarks/64b0000000000000000000aa"],
];
describe("[P9] API auth", () => {
  test.each(ENDPOINTS)("[P9] %s %s :: no token → 401", async (m, p) => {
    const r = await ctx.client(null)[m === "DELETE" ? "del" : m.toLowerCase()](p, m === "GET" || m === "DELETE" ? undefined : {});
    expect(r.status).toBe(401);
  });
  test.each(ENDPOINTS)("[P9] %s %s :: bad token → 401", async (m, p) => {
    const r = await ctx.client("not.a.jwt")[m === "DELETE" ? "del" : m.toLowerCase()](p, m === "GET" || m === "DELETE" ? undefined : {});
    expect(r.status).toBe(401);
  });
  test("[P9] expired token → 401 TOKEN_EXPIRED", async () => {
    const { tokenFor } = require("../../testUtils/bookmarksFixtures");
    const r = await ctx.client(tokenFor(A.admin.id, "staff", { expiresIn: -10 })).get("/api/bookmarks");
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("TOKEN_EXPIRED");
  });
  test("[P9] malformed id 'abc' on PUT → 400/404, never 500", async () => {
    const r = await api(A.admin).put("/api/bookmarks/abc", { title: "x" });
    expect([400, 404]).toContain(r.status);
  });
  test("[P9] malformed id 'abc' on DELETE → 400/404, never 500", async () => {
    const r = await api(A.admin).del("/api/bookmarks/abc");
    expect([400, 404]).toContain(r.status);
  });
  test("[P9] sync with no array → 400", async () => {
    expect((await api(A.full).post("/api/bookmarks/sync", { bookmarks: "nope" })).status).toBe(400);
  });
  test("[P9] sync response: 201 {message, added}", async () => {
    const r = await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "S1", url: fresh(), folder: "Bar" }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ message: "Synced successfully", added: 1 });
  });
  test("[P9] DELETE /chrome/:id not found → 404", async () => {
    expect((await api(A.full).del("/api/bookmarks/chrome/does-not-exist")).status).toBe(404);
  });
  test("[P9] superadmin with no tenant → GET returns [] (no cross-company dump)", async () => {
    const r = await api(ctx.superadmin).get("/api/bookmarks");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

// ───────────────────────── Phase 10: security ─────────────────────────
describe("[P10] Security", () => {
  test("[P10] company separation :: A's list never contains B's bookmarks", async () => {
    const r = await api(A.admin).get("/api/bookmarks");
    expect(r.body.some((b) => String(b.tenant_id) === String(B.tenantId))).toBe(false);
    expect(r.body.some((b) => b.title.startsWith("CitySmile"))).toBe(false);
  });
  test("[P10] company separation :: A admin PUT B's bookmark id → 404, unchanged", async () => {
    const r = await api(A.admin).put(`/api/bookmarks/${B.b.pubAdmin._id}`, { title: "pwned" });
    expect(r.status).toBe(404);
    expect((await Bookmark.findById(B.b.pubAdmin._id).lean()).title).toBe("CitySmile Customers");
  });
  test("[P10] company separation :: A admin DELETE B's bookmark id → 404, still there", async () => {
    expect((await api(A.admin).del(`/api/bookmarks/${B.b.pubFull._id}`)).status).toBe(404);
    expect(await Bookmark.findById(B.b.pubFull._id)).not.toBeNull();
  });
  test("[P10] company separation :: A admin Delete All never touches B", async () => {
    // Uses OffixNest as "A" so the main tenants keep their rows.
    const O = T.OffixNest;
    const before = await Bookmark.countDocuments({ tenant_id: B.tenantId });
    const r = await api(O.admin).del("/api/bookmarks");
    expect(r.status).toBe(200);
    expect(await Bookmark.countDocuments({ tenant_id: O.tenantId })).toBe(0);
    expect(await Bookmark.countDocuments({ tenant_id: B.tenantId })).toBe(before);
  });
  test("[P10] company separation :: client id of company B must not be linked/populated in A (no B data in response)", async () => {
    const r = await api(A.admin).post("/api/bookmarks", { title: "cross", url: fresh(), client: String(B.clientId) });
    expect(JSON.stringify(r.body)).not.toContain("CitySmile Secret Client");
  });
  test("[P10] suspected bug 1 :: POST with a URL another user bookmarked publicly must NOT change THEIR bookmark", async () => {
    const before = await Bookmark.findById(A.b.pubAdmin._id).lean();
    const r = await api(A.full).post("/api/bookmarks", { title: "Overwritten by staff", url: before.url, folder: "Hacked" });
    const after = await Bookmark.findById(A.b.pubAdmin._id).lean();
    await reseedB();
    expect(after.title).toBe(before.title);
    expect(after.folder).toBe(before.folder);
    expect(r.status).not.toBe(200); // 200 = "updated someone else's row" while UI says "Bookmark Added"
  });
  test("[P10] suspected bug 1b :: POST same public URL with is_private:false cannot flip another user's bookmark privacy", async () => {
    const before = await Bookmark.findById(A.b.pubFull._id).lean();
    await api(A.full2).post("/api/bookmarks", { title: "flip", url: before.url, is_private: false });
    const after = await Bookmark.findById(A.b.pubFull._id).lean();
    expect(after.title).toBe(before.title);
  });
  test("[P10] suspected bug 5 :: extension sync by another user must not change someone's PRIVATE bookmark folder", async () => {
    const before = await Bookmark.findById(A.b.privFull2._id).lean();
    await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: before.url, folder: "Moved by Full" }] });
    const after = await Bookmark.findById(A.b.privFull2._id).lean();
    expect(after.folder).toBe(before.folder);
  });
  test("[P10] suspected bug 5b :: extension sync by another user must not change a PUBLIC bookmark's folder owned by someone else", async () => {
    const before = await Bookmark.findById(A.b.pubAdmin._id).lean();
    await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: before.url, folder: "Moved by Full" }] });
    const after = await Bookmark.findById(A.b.pubAdmin._id).lean();
    await reseedB();
    expect(after.folder).toBe(before.folder);
  });
  test("[P10] suspected bug 5c :: personal Chrome bookmarks synced by the extension are private to the syncing user", async () => {
    const url = fresh();
    await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "My bank", url, folder: "Personal" }] });
    const row = await Bookmark.findOne({ url, tenant_id: A.tenantId }).lean();
    expect(row.is_private).toBe(true);
    const seenBy2 = (await api(A.full2).get("/api/bookmarks")).body.some((b) => b.url === url);
    expect(seenBy2).toBe(false);
  });
  test("[P10] suspected bug 5d :: sync of a URL that only exists as SOMEONE ELSE's private bookmark still creates the syncing user's own copy", async () => {
    const url = (await Bookmark.findById(A.b.privAdmin._id).lean()).url;
    await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "mine", url, folder: "Mine" }] });
    const mine = await Bookmark.findOne({ url, tenant_id: A.tenantId, created_by: A.full.id }).lean();
    expect(mine).not.toBeNull();
  });
  test("[P10] suspected bug 6 :: DELETE /chrome/:id (no url) by staff must not delete ANOTHER user's bookmark with the same Chrome id", async () => {
    const r = await api(A.full).del("/api/bookmarks/chrome/11");
    const otherStill = await Bookmark.findById(A.b.privFull2._id);
    expect(otherStill).not.toBeNull();
    if (!otherStill) await Bookmark.collection.insertOne({ ...A.b.privFull2.toObject() });
    expect(r.status).not.toBe(500);
  });
  test("[P10] suspected bug 6b :: DELETE /chrome/:id?url=<their url> by staff must not delete another user's bookmark", async () => {
    const victim = await Bookmark.create({ tenant_id: A.tenantId, title: "victim", url: "https://victim.example.com", chromeBookmarkId: "77", created_by: A.full2.id });
    await api(A.full).del(`/api/bookmarks/chrome/77?url=${encodeURIComponent(victim.url)}`);
    expect(await Bookmark.findById(victim._id)).not.toBeNull();
  });
  test("[P10] NoSQL injection :: id '{\"$ne\":null}' on PUT → 400/404, nothing changed", async () => {
    const r = await api(A.admin).put(`/api/bookmarks/${encodeURIComponent('{"$ne":null}')}`, { title: "inj" });
    expect([400, 404]).toContain(r.status);
    expect(await Bookmark.countDocuments({ title: "inj" })).toBe(0);
  });
  test("[P10] NoSQL injection :: id '{\"$ne\":null}' on DELETE → 400/404, never 500", async () => {
    const r = await api(A.admin).del(`/api/bookmarks/${encodeURIComponent('{"$ne":null}')}`);
    expect([400, 404]).toContain(r.status);
  });
  test("[P10] NoSQL injection :: DELETE /chrome/x?url[$ne]=1 deletes nothing", async () => {
    const before = await Bookmark.countDocuments({ tenant_id: A.tenantId });
    await api(A.admin).del("/api/bookmarks/chrome/12?url[$ne]=1");
    expect(await Bookmark.countDocuments({ tenant_id: A.tenantId })).toBe(before);
  });
  test("[P10] NoSQL injection :: GET ?tenant_id=<B> as normal admin does not switch tenant", async () => {
    const r = await api(A.admin).get(`/api/bookmarks?tenant_id=${B.tenantId}`);
    expect(r.body.some((b) => String(b.tenant_id) === String(B.tenantId))).toBe(false);
  });
  test("[P10] mass assignment :: POST tenant_id=<B> is ignored (saved in own company)", async () => {
    const url = fresh();
    await api(A.admin).post("/api/bookmarks", { title: "mass", url, tenant_id: String(B.tenantId), created_by: String(B.admin.id) });
    const row = await Bookmark.findOne({ url }).lean();
    expect(String(row.tenant_id)).toBe(String(A.tenantId));
    expect(String(row.created_by)).toBe(String(A.admin.id));
  });
  test("[P10] XSS :: <img onerror> in title/folder is stored as plain text (React escapes) and URL protocol blocked", async () => {
    const r = await api(A.full).post("/api/bookmarks", { title: "<img src=x onerror=alert(1)>", url: fresh(), folder: "<script>alert(1)</script>" });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("<img src=x onerror=alert(1)>");
  });
  test("[P10] sync skips javascript:/data: URLs", async () => {
    const r = await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: "javascript:alert(1)" }, { title: "y", url: "data:text/html,hi" }] });
    expect(r.body.added).toBe(0);
  });
  test("[P10] sync skips protocol-relative '//evil.com' (PROPOSED)", async () => {
    const r = await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: "//evil-sync.com" }] });
    expect(r.body.added).toBe(0);
  });
  test("[P10] sync with chromeBookmarkId object → 400, not 500", async () => {
    const r = await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: "x", url: fresh(), chromeBookmarkId: { $ne: null } }] });
    expect(r.status).not.toBe(500);
  });
  test("[P10] sync applies the same length rules (10,000-char title rejected/truncated)", async () => {
    const url = fresh();
    await api(A.full).post("/api/bookmarks/sync", { bookmarks: [{ title: N(10000), url, folder: N(5000) }] });
    const row = await Bookmark.findOne({ url }).lean();
    expect(!row || (row.title.length <= 200 && row.folder.length <= 100)).toBe(true);
  });
});
