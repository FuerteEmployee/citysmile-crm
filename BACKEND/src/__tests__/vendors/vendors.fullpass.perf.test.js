// Vendors phase 11 (performance), local machine only, in-memory MongoDB.
// 10,000 vendors in the "Perf" tenant; list with "All", paged list, search, import 5,000 rows,
// 20 users at once. Numbers are written to test-results/vendors/perf.json (local numbers, not production claims).
jest.setTimeout(600000);
process.env.VENDORS_PERF_COUNT = "10000";

const fs = require("fs");
const path = require("path");
const { boot } = require("../../testUtils/startVendorsFullTestStack");

let W;
const out = {};
const timed = async (label, fn) => { const t = Date.now(); const r = await fn(); out[label] = Date.now() - t; return r; };
const get = async (tok, p) => { const r = await fetch(W.baseUrl + p, { headers: { Authorization: `Bearer ${tok}` } }); const b = await r.json(); return { status: r.status, body: b, bytes: JSON.stringify(b).length }; };

beforeAll(async () => { W = await boot({ port: 0 }); });
afterAll(async () => {
  const dir = path.resolve(__dirname, "../../../../test-results/vendors");
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "perf.json"), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  if (W) await W.stop();
});

test("GET all 10,000 (the 'All' page size and Export) < 5 s", async () => {
  const tok = W.P.admin.token;
  const r = await timed("list_all_10000_ms", () => get(tok, "/api/vendors"));
  out.list_all_10000_bytes = r.bytes;
  expect(r.status).toBe(200);
  expect(r.body.length).toBe(10000);
  expect(out.list_all_10000_ms).toBeLessThan(5000);
});
test("paged list (25) and last page < 1 s", async () => {
  const tok = W.P.admin.token;
  const r = await timed("list_page1_25_ms", () => get(tok, "/api/vendors?page=1&limit=25"));
  expect(r.body.total).toBe(10000);
  await timed("list_page400_25_ms", () => get(tok, "/api/vendors?page=400&limit=25"));
  expect(out.list_page1_25_ms).toBeLessThan(1000);
  expect(out.list_page400_25_ms).toBeLessThan(1000);
});
test("search across 11 fields on 10,000 < 1.5 s", async () => {
  const r = await timed("search_10000_ms", () => get(W.P.admin.token, "/api/vendors?page=1&limit=25&search=Perf%20Vendor%2009999"));
  expect(r.body.total).toBe(1);
  expect(out.search_10000_ms).toBeLessThan(1500);
});
test("20 users at once on the paged list: all 200, p95 < 3 s", async () => {
  const tok = W.P.admin.token;
  const times = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const t = Date.now();
    const r = await get(tok, `/api/vendors?page=${i + 1}&limit=25&search=${i % 2 ? "Sales" : ""}`);
    expect(r.status).toBe(200);
    return Date.now() - t;
  }));
  times.sort((a, b) => a - b);
  out.concurrent20_p50_ms = times[9];
  out.concurrent20_p95_ms = times[18];
  out.concurrent20_max_ms = times[19];
  expect(out.concurrent20_p95_ms).toBeLessThan(3000);
});
test("20 users at once loading 'All' (10,000 rows each)", async () => {
  const tok = W.P.admin.token;
  const t = Date.now();
  const rs = await Promise.all(Array.from({ length: 20 }, () => get(tok, "/api/vendors")));
  out.concurrent20_all_total_ms = Date.now() - t;
  expect(rs.every((r) => r.status === 200)).toBe(true);
});
test("import 5,000 rows < 15 s, all created", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ company_name: `Imported Perf ${i}`, phone_number: "9876543210", email: `imp${i}@perf.test`, pan_number: "ABCDE1234F", gst_number: "24ABCDE1234F1Z5" }));
  const r = await timed("import_5000_ms", async () => {
    const res = await fetch(`${W.baseUrl}/api/vendors/import`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${W.P.admin.token}` }, body: JSON.stringify(rows) });
    return { status: res.status, body: await res.json() };
  });
  expect(r.status).toBe(201);
  expect(r.body.created).toBe(5000);
  expect(out.import_5000_ms).toBeLessThan(15000);
});
