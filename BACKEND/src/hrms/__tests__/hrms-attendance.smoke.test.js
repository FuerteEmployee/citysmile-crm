// HRMS Part B — harness smoke: in-memory DB guard, port 5207, fake clock, stubs.
const H = require("../../testUtils/hrms-attendance.harness");

jest.setTimeout(120000);
const FAKE = ["Date"];
const NOT_FAKED = ["hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"];

let db, T, srv, api;
beforeAll(async () => {
  H.installStubs();
  db = await H.startDb();
  T = await H.seedAll();
  srv = H.buildApp();
  const base = await H.listen(srv.server);
  api = H.makeClient(base + "/api/hrms");
  jest.useFakeTimers({ doNotFake: NOT_FAKED });
});
afterAll(async () => {
  jest.useRealTimers();
  srv.io.close();
  await new Promise((r) => srv.server.close(r));
  await db.mongoose.disconnect();
  await db.mongod.stop();
});

test("guard: connected to in-memory 127.0.0.1 and listening on 5207", async () => {
  expect(process.env.MONGO_URI.startsWith("mongodb://127.0.0.1")).toBe(true);
  expect(srv.server.address().port).toBe(5207);
  expect(FAKE).toEqual(["Date"]);
});

test("fake clock drives IST date/time used by punch-in", async () => {
  jest.setSystemTime(H.ist("2026-10-14T09:40:00"));
  const r = await api(T.A.people.emp1.token).post("/attendance/punch-in", H.punchForm({ lat: H.HQ.lat, lng: H.HQ.lng, accuracy: 10 }));
  expect(r.status).toBe(201);
  expect(r.body.data.date).toBe("2026-10-14");
  expect(r.body.data.punchIn.time).toBe("09:40:00");
});
