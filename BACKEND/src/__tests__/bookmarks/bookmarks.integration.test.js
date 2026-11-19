// Bookmarks module — integration suite (phase 5): CRM Agent tools, Chrome extension
// (real api.js/background.js run in a vm with a fake chrome API, calling the in-memory
// test backend), manifest/domain checks, sidebar/plan wiring. In-memory MongoDB only.
// Each test states the CORRECT behaviour; a failure = a bug.
jest.setTimeout(120000);

const fs = require("fs");
const path = require("path");
const { bootBookmarks, tokenFor } = require("../../testUtils/bookmarksFixtures");
const { loadExtension, EXT_DIR } = require("../../testUtils/bookmarksExtensionHarness");

let ctx, T, A, Bookmark, Staff;
beforeAll(async () => {
  ctx = await bootBookmarks();
  ({ T, Bookmark, Staff } = ctx);
  A = T.BeOnTime;
});
afterAll(async () => { await ctx.stop(); });

// ───────────── CRM Agent (in-app assistant) generic tools ─────────────
describe("[P5] CRM Agent assistant (runTools, no AI call)", () => {
  let runTools;
  const reqFor = async (who) => ({ user: await Staff.findById(who.id).select("-password"), userRole: "staff" });
  const run = async (who, name, input) => {
    const out = await runTools([{ type: "tool_use", id: "t1", name, input }], await reqFor(who));
    return out.toolResults ? out.toolResults[0] : (Array.isArray(out) ? out[0] : out);
  };
  const text = (r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
  beforeAll(() => { ({ runTools } = require("../../controllers/assistant_controller")); });

  test("[P5] agent search_records(bookmark) as staff must NOT return another user's PRIVATE bookmark (suspected bug 17)", async () => {
    const r = await run(A.full, "search_records", { module: "bookmark", query: "Private" });
    expect(text(r)).not.toContain("BeOnTime Private Fulltwo");
    expect(text(r)).not.toContain("BeOnTime Private Admin");
  });
  test("[P5] agent search_records(bookmark) never returns another company's bookmarks", async () => {
    const r = await run(A.full, "search_records", { module: "bookmark", query: "Customers" });
    expect(text(r)).not.toContain("CitySmile");
  });
  test("[P5] agent update_record(bookmark) as staff on the ADMIN's bookmark must be refused (owner check)", async () => {
    await run(A.full, "update_record", { module: "bookmark", id: String(A.b.pubAdmin._id), fields: { title: "Agent hijack" } });
    const row = await Bookmark.findById(A.b.pubAdmin._id).lean();
    await Bookmark.updateOne({ _id: A.b.pubAdmin._id }, { title: "BeOnTime Customers" });
    expect(row.title).toBe("BeOnTime Customers");
  });
  test("[P5] agent delete_record(bookmark, confirmed twice) as staff on another user's PRIVATE bookmark must be refused", async () => {
    const victim = await Bookmark.create({ tenant_id: A.tenantId, title: "Agent victim", url: "https://agent-victim.example.com", is_private: true, created_by: A.full2.id });
    await run(A.full, "delete_record", { module: "bookmark", id: String(victim._id), confirm: true, confirm_final: true });
    expect(await Bookmark.findById(victim._id)).not.toBeNull();
  });
  test("[P5] agent create_record(bookmark) rejects a javascript: URL (same rules as the API)", async () => {
    await run(A.full, "create_record", { module: "bookmark", fields: { title: "Agent XSS", url: "javascript:alert(1)" } });
    expect(await Bookmark.findOne({ title: "Agent XSS" })).toBeNull();
  });
  test("[P5] agent create_record(bookmark) records the creator (created_by) like the screen does", async () => {
    await run(A.full, "create_record", { module: "bookmark", fields: { title: "Agent made", url: "https://agent-made.example.com" } });
    const row = await Bookmark.findOne({ title: "Agent made" }).lean();
    expect(row).not.toBeNull();
    expect(String(row.created_by)).toBe(String(A.full.id));
  });
  test("[P5] agent refuses bookmark tools for staff WITHOUT the Bookmarks permission (PROPOSED)", async () => {
    const r = await run(A.noPerm, "search_records", { module: "bookmark", query: "Customers" });
    expect(text(r)).not.toContain("BeOnTime Customers");
  });
  test("[P5] agent refuses bookmark tools when the plan module 'bookmarks' is off", async () => {
    const P = T.NoBookmarksPlan;
    const r = await run(P.admin, "search_records", { module: "bookmark", query: "Customers" });
    expect(text(r)).not.toContain("NoBookmarksPlan Customers");
  });
});

// ───────────── Sidebar / plan / roles wiring (static + DB) ─────────────
describe("[P5] Sidebar, plan and roles wiring", () => {
  test("[P5] default sidebar has 'Bookmarks' in Main group with permission 'Bookmarks'", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../controllers/mainsidebar_controller.js"), "utf8");
    expect(src).toMatch(/title: "Bookmarks", url: "\/admin\/bookmarks", icon: "Bookmark", permission: "Bookmarks", group: "Main"/);
  });
  test("[P5] SaaS plan schema has module_access.bookmarks (default true)", () => {
    const SaasPlan = require("../../models/SaasPlan");
    expect(SaasPlan.schema.path("module_access.bookmarks")).toBeTruthy();
  });
  test("[P5] plan gate maps /api/bookmarks → 'bookmarks'", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../middleware/planModules.js"), "utf8");
    expect(src).toContain('["/bookmarks", "bookmarks"]');
  });
  test("[P5] backend routes enforce the 'Bookmarks' role permission (PROPOSED) — route file uses checkPermission('Bookmarks')", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../routes/bookmark_routes.js"), "utf8");
    expect(src).toMatch(/checkPermission\(\s*["']Bookmarks["']/);
  });
});

// ───────────── Chrome extension (real scripts, fake chrome API) ─────────────
describe("[P5] Chrome extension against the test backend", () => {
  const tree = (extra = []) => [{
    id: "0", title: "", children: [
      { id: "1", title: "Bookmarks bar", children: [
        { id: "101", title: "Ext GST", url: "https://ext-gst.example.com/" },
        { id: "102", title: "Chrome settings", url: "chrome://settings/" },
        { id: "103", title: "Edge flags", url: "edge://flags/" },
        { id: "110", title: "Finance", children: [{ id: "111", title: "Ext Bank", url: "https://ext-bank.example.com/" }] },
        ...extra,
      ] },
    ],
  }];
  const ext = (who, more = {}) => loadExtension({
    storage: { crm_api_url: `${ctx.baseUrl}/api/`, crm_token: who.token, crm_refresh_token: who.refresh, ...more },
    tree: tree(),
  });

  test("[P5] Sync button (SYNC_ALL) → ok, 'X new of Y', chrome:// and edge:// skipped, folders kept", async () => {
    const e = ext(A.full);
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res).toMatchObject({ ok: true, added: 2, total: 2 });
    const bank = await Bookmark.findOne({ url: "https://ext-bank.example.com/", tenant_id: A.tenantId }).lean();
    expect(bank.folder).toBe("Finance");
    expect(String(bank.chromeBookmarkId)).toBe("111");
    expect(await Bookmark.countDocuments({ url: /^(chrome|edge):/ })).toBe(0);
    expect(e.calls.filter((c) => c.url.includes("/bookmarks/sync"))).toHaveLength(1);
  });
  test("[P5] Sync again → 0 new of 2 (no duplicates)", async () => {
    const e = ext(A.full);
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res).toMatchObject({ ok: true, added: 0, total: 2 });
    expect(await Bookmark.countDocuments({ url: "https://ext-gst.example.com/", tenant_id: A.tenantId })).toBe(1);
  });
  test("[P5] add a Chrome bookmark (onCreated) → appears in CRM", async () => {
    const e = ext(A.full);
    const node = { id: "201", parentId: "110", title: "Ext New", url: "https://ext-new.example.com/" };
    e.setTree(tree([node]));
    e.fire("created", "201", node);
    await e.idle();
    const row = await Bookmark.findOne({ url: node.url, tenant_id: A.tenantId }).lean();
    expect(row).not.toBeNull();
    expect(row.folder).toBe("Finance");
    expect(e.badge.text).toBe("");
  });
  test("[P5] move a Chrome bookmark (onMoved) → folder changes in CRM", async () => {
    const e = ext(A.full);
    const moved = { id: "201", parentId: "1", title: "Ext New", url: "https://ext-new.example.com/" };
    e.setTree(tree([moved]));
    e.fire("moved", "201", { parentId: "1" });
    await e.idle();
    const row = await Bookmark.findOne({ url: moved.url, tenant_id: A.tenantId }).lean();
    expect(row.folder).toBe("Bookmarks bar");
  });
  test("[P5] delete a Chrome bookmark (onRemoved) → removed from CRM", async () => {
    const e = ext(A.full);
    e.fire("removed", "201", { parentId: "1", node: { id: "201", title: "Ext New", url: "https://ext-new.example.com/" } });
    await e.idle();
    expect(await Bookmark.findOne({ url: "https://ext-new.example.com/", tenant_id: A.tenantId })).toBeNull();
  });
  test("[P5] delete a Chrome folder → every bookmark inside removed; chrome:// children skipped", async () => {
    const e = ext(A.full);
    e.fire("removed", "110", { parentId: "1", node: { id: "110", title: "Finance", children: [{ id: "111", url: "https://ext-bank.example.com/" }, { id: "199", url: "chrome://x" }] } });
    await e.idle();
    expect(await Bookmark.findOne({ url: "https://ext-bank.example.com/", tenant_id: A.tenantId })).toBeNull();
    expect(e.calls.some((c) => c.url.includes("chrome%3A%2F%2F") || c.url.includes("/chrome/199"))).toBe(false);
  });
  test("[P5] importing 150 bookmarks → ONE sync call at the end, not 150", async () => {
    const e = ext(A.full);
    const nodes = Array.from({ length: 150 }, (_, i) => ({ id: `9${i}`, parentId: "1", title: `Imp ${i}`, url: `https://imp${i}.example.com/` }));
    e.setTree(tree(nodes));
    e.fire("importBegan");
    nodes.forEach((n) => e.fire("created", n.id, n));
    // Chrome delivers events as separate tasks; let the created handlers run before import ends.
    await new Promise((r) => setTimeout(r, 300));
    e.fire("importEnded");
    await e.idle();
    expect(e.calls.filter((c) => c.url.includes("/bookmarks"))).toHaveLength(1);
    expect(await Bookmark.countDocuments({ url: /^https:\/\/imp\d+\.example\.com/, tenant_id: A.tenantId })).toBe(150);
  });
  test("[P5] auto-sync OFF → adding a Chrome bookmark makes no API call", async () => {
    const e = ext(A.full, { auto_sync: false });
    e.fire("created", "301", { id: "301", parentId: "1", title: "x", url: "https://autosync-off.example.com/" });
    await e.idle();
    expect(e.calls).toHaveLength(0);
  });
  test("[P5] Disconnected (no token) → no API call, sync reports 'Not connected'", async () => {
    const e = ext(A.full, { crm_token: "", crm_refresh_token: "" });
    e.fire("created", "302", { id: "302", parentId: "1", title: "x", url: "https://disc.example.com/" });
    await e.idle();
    expect(e.calls).toHaveLength(0);
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Not connected/);
  });
  test("[P5] expired access token + valid refresh token → refreshed automatically, sync works, new token saved", async () => {
    const expired = tokenFor(A.full.id, "staff", { expiresIn: -60 });
    const e = ext(A.full, { crm_token: expired });
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res.ok).toBe(true);
    expect(e.calls.some((c) => c.url.endsWith("/auth/refresh"))).toBe(true);
    expect(e.store.crm_token).not.toBe(expired);
  });
  test("[P5] expired token + bad refresh token → red '!' badge on auto-sync failure", async () => {
    const expired = tokenFor(A.full.id, "staff", { expiresIn: -60 });
    const e = ext(A.full, { crm_token: expired, crm_refresh_token: "garbage" });
    e.fire("created", "303", { id: "303", parentId: "1", title: "x", url: "https://badrefresh.example.com/" });
    await e.idle();
    expect(e.badge.text).toBe("!");
    expect(e.badge.color).toBe("#dc2626");
    expect(e.store.last_error).toMatch(/Session expired/);
  });
  test("[P5] plan module off → sync shows the server's 403 message (no silent success)", async () => {
    const P = T.NoBookmarksPlan;
    const e = loadExtension({ storage: { crm_api_url: `${ctx.baseUrl}/api`, crm_token: P.admin.token }, tree: tree() });
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res.ok).toBe(false);
  });
  test("[P5] Rudraverse tenant: Sync works with a Rudraverse token", async () => {
    const R = T.Rudraverse;
    const e = ext(R.admin);
    const res = await e.sendMessage({ type: "SYNC_ALL" });
    expect(res.ok).toBe(true);
    expect(await Bookmark.countDocuments({ tenant_id: R.tenantId, url: "https://ext-gst.example.com/" })).toBe(1);
  });
  test("[P5] extension removal of a bookmark another staff also has (same Chrome id + URL) must not delete THEIR copy", async () => {
    const victim = await Bookmark.create({ tenant_id: A.tenantId, title: "Same id", url: "https://same-id.example.com/", chromeBookmarkId: "555", created_by: A.full2.id, is_private: true });
    const e = ext(A.full);
    e.fire("removed", "555", { parentId: "1", node: { id: "555", url: "https://same-id.example.com/" } });
    await e.idle();
    expect(await Bookmark.findById(victim._id)).not.toBeNull();
  });
});

describe("[P5] Extension manifest / domains (static)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  const apiSrc = fs.readFileSync(path.join(EXT_DIR, "api.js"), "utf8");
  test.each([
    ["crm.beontimeofficial.com"], ["rudraverse.trinetratechnoworld.com"], ["crm.citysmile.in"], ["crm.kiranenginers.com"], ["crm.offixnest.com"],
  ])("[P5] Connect possible on %s (in host_permissions AND CRM_TAB_PATTERN)", (host) => {
    expect(manifest.host_permissions.some((h) => h.includes(host))).toBe(true);
    expect(apiSrc).toContain(`https://${host}/*`);
  });
  test("[P5] manifest has no localhost host permission (release build, suspected bug 18)", () => {
    expect(manifest.host_permissions.some((h) => h.includes("localhost"))).toBe(false);
  });
});
