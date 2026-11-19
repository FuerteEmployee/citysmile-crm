// Bookmarks module — performance (phase 11): 2,000 bookmarks in one company, 20 users at once.
// Local in-memory numbers only (not production claims). Writes timings to
// test-results/bookmarks/perf.json. Thresholds are generous sanity limits.
jest.setTimeout(300000);

const fs = require("fs");
const path = require("path");
const { bootBookmarks, seedBulk } = require("../../testUtils/bookmarksFixtures");

let ctx, A;
const out = {};
beforeAll(async () => {
  ctx = await bootBookmarks();
  A = ctx.T.BeOnTime;
  await seedBulk(A.tenantId, A.full.id, 2000);
});
afterAll(async () => {
  const dir = path.resolve(__dirname, "../../../../test-results/bookmarks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "perf.json"), JSON.stringify(out, null, 2));
  await ctx.stop();
});

const time = async (fn) => { const t = Date.now(); const r = await fn(); return [Date.now() - t, r]; };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

test("[P11] GET /api/bookmarks with ~2,000 rows (admin) — 10 runs", async () => {
  const runs = [];
  let size = 0;
  for (let i = 0; i < 10; i++) {
    const [ms, r] = await time(() => ctx.client(A.admin.token).get("/api/bookmarks"));
    expect(r.status).toBe(200);
    size = r.body.length;
    runs.push(ms);
  }
  out.adminList = { rows: size, avgMs: Math.round(runs.reduce((a, b) => a + b) / runs.length), p95Ms: pct(runs, 95), maxMs: Math.max(...runs) };
  expect(size).toBeGreaterThanOrEqual(2000);
  expect(out.adminList.avgMs).toBeLessThan(3000);
});

test("[P11] GET /api/bookmarks as staff (filtered $or) — 10 runs", async () => {
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push((await time(() => ctx.client(A.full2.token).get("/api/bookmarks")))[0]);
  out.staffList = { avgMs: Math.round(runs.reduce((a, b) => a + b) / runs.length), p95Ms: pct(runs, 95) };
  expect(out.staffList.avgMs).toBeLessThan(3000);
});

test("[P11] 20 users at once: 20 parallel GETs (2,000 rows each)", async () => {
  const users = [A.admin, A.full, A.full2, A.roleAdmin];
  const [total, rs] = await time(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
    time(() => ctx.client(users[i % users.length].token).get("/api/bookmarks")))));
  const each = rs.map(([ms]) => ms);
  out.concurrent20 = { wallMs: total, avgMs: Math.round(each.reduce((a, b) => a + b) / 20), p95Ms: pct(each, 95), maxMs: Math.max(...each), allOk: rs.every(([, r]) => r.status === 200) };
  expect(out.concurrent20.allOk).toBe(true);
  expect(total).toBeLessThan(20000);
});

test("[P11] 20 users at once: 20 parallel POSTs", async () => {
  const [total, rs] = await time(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
    ctx.client(A.full.token).post("/api/bookmarks", { title: `Conc ${i}`, url: `https://conc${i}.example.com` }))));
  out.concurrentPost20 = { wallMs: total, allCreated: rs.every((r) => r.status === 201) };
  expect(out.concurrentPost20.allCreated).toBe(true);
});

test("[P11] sync of 500 bookmarks in one call (extension full sync)", async () => {
  const bookmarks = Array.from({ length: 500 }, (_, i) => ({ title: `Sync ${i}`, url: `https://sync${i}.example.com/`, chromeBookmarkId: `s${i}`, folder: "Bar" }));
  const [ms, r] = await time(() => ctx.client(A.full.token).post("/api/bookmarks/sync", { bookmarks }));
  out.sync500 = { ms, added: r.body.added };
  expect(r.status).toBe(201);
  expect(ms).toBeLessThan(30000);
});

test("[P11] response size of the 2,000-row list (no pagination — everything loads at once)", async () => {
  const r = await fetch(`${ctx.baseUrl}/api/bookmarks`, { headers: { Authorization: `Bearer ${A.admin.token}` } });
  const txt = await r.text();
  out.listPayloadKB = Math.round(txt.length / 1024);
  expect(out.listPayloadKB).toBeGreaterThan(0);
});
