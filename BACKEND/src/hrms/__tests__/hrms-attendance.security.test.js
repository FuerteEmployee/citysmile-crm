// HRMS Part B — roles, API contract, security (company separation, NoSQL, tokens),
// Socket.IO rooms, plan gate, Face Attendance / Kiosk and selfie face check.
// In-memory MongoDB + backend on 127.0.0.1:5207. Face service is stubbed in-process
// (see harness FACE STUB PROTOCOL). Each test asserts the EXPECTED rule.
const path = require("path");
const H = require("../../testUtils/hrms-attendance.harness");
const { io: ioClient } = require(path.resolve(__dirname, "../../../../FRONTEND/node_modules/socket.io-client"));

jest.setTimeout(180000);
const NOT_FAKED = ["hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"];

let db, T, srv, base, api, A, B, P, R, Attendance;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (s) => jest.setSystemTime(H.ist(s));
const IN = { lat: H.HQ.lat, lng: H.HQ.lng, accuracy: 10 };
const punchIn = (who, time, loc = IN, selfie) => { at(time); return api(who.token).post("/attendance/punch-in", H.punchForm(loc, selfie)); };
const punchOut = (who, time, loc = IN, selfie) => { at(time); return api(who.token).post("/attendance/punch-out", H.punchForm(loc, selfie)); };
const imgForm = (field, contents) => {
  const fd = new FormData();
  for (const c of contents) fd.append(field, new Blob([Buffer.from(c)], { type: "image/jpeg" }), "p.jpg");
  return fd;
};

beforeAll(async () => {
  H.installStubs();
  db = await H.startDb();
  T = await H.seedAll();
  ({ A, B, P, R } = T);
  srv = H.buildApp();
  base = await H.listen(srv.server);
  api = H.makeClient(base + "/api/hrms");
  Attendance = require("../models/attendance_model");
  jest.useFakeTimers({ doNotFake: NOT_FAKED });
  // Some attendance in both companies.
  await punchIn(A.people.emp1, "2026-10-14T09:30:00");
  await punchOut(A.people.emp1, "2026-10-14T18:30:00");
  await punchIn(A.people.emp2, "2026-10-14T09:30:00");
  await punchIn(A.people.otherBranch, "2026-10-14T09:30:00");
  await punchIn(B.people.emp1, "2026-10-14T09:30:00");
});
afterAll(async () => {
  jest.useRealTimers();
  await sleep(300);
  srv.io.close();
  await new Promise((r) => srv.server.close(r));
  await db.mongoose.disconnect();
  await db.mongod.stop();
});

const recId = async (who, date = "2026-10-14") => String((await Attendance.findOne({ userId: who.userId, date }).lean())._id);

describe("API: no token / bad token -> 401 on every Part B endpoint", () => {
  const eps = [
    ["get", "/attendance"], ["get", "/attendance/today"], ["get", "/attendance/history"], ["get", "/attendance/absent"],
    ["post", "/attendance/punch-in"], ["post", "/attendance/punch-out"], ["post", "/attendance/lunch-in"], ["post", "/attendance/lunch-out"],
    ["post", "/attendance/auto-punch-out"], ["get", "/attendance/geo-fence/check?lat=1&lng=1"], ["patch", "/attendance/admin-correct"],
    ["post", "/attendance/import"], ["get", "/shifts"], ["post", "/shifts"], ["get", "/holidays"], ["post", "/holidays"],
    ["get", "/locations/latest"], ["get", "/locations/path?employeeId=x"], ["get", "/locations/geofence-audit"], ["post", "/locations/update"],
    ["get", "/face/me"], ["get", "/face/status"], ["post", "/face/kiosk/punch"],
  ];
  test.each(eps)("%s %s", async (m, p) => {
    at("2026-10-14T12:00:00");
    expect((await api(null)[m](p, m === "get" ? undefined : {})).status).toBe(401);
    expect((await api("RAW:Bearer not.a.jwt")[m](p, m === "get" ? undefined : {})).status).toBe(401);
  });
});

describe("Plan module 'hrms' off -> 403 MODULE_DISABLED (shifts stay open)", () => {
  const p = () => api(P.people.admin.token);
  test.each([["/attendance"], ["/attendance/today"], ["/holidays"], ["/locations/latest"], ["/face/me"], ["/locations/geofence-audit"]])("GET %s -> 403", async (u) => {
    const r = await p().get(u);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_DISABLED");
  });
  test("[+] GET /shifts stays open -> 200", async () => {
    expect((await p().get("/shifts")).status).toBe(200);
  });
  test("[-] punch-in blocked -> 403", async () => {
    expect((await p().post("/attendance/punch-in", H.punchForm(IN))).status).toBe(403);
  });
});

describe("Role-based access: normal employee (no HRMS permission) gets 403 on management APIs", () => {
  const e = () => api(A.people.emp1.token);
  test.each([
    ["GET /attendance (all staff attendance)", "get", "/attendance"],
    ["GET /attendance?date (dashboard)", "get", "/attendance?date=2026-10-14"],
    ["GET /attendance/absent", "get", "/attendance/absent?date=2026-10-14"],
    ["GET /locations/latest (everyone's live location)", "get", "/locations/latest"],
    ["GET /locations/geofence-audit", "get", "/locations/geofence-audit"],
  ])("[-] %s -> 403", async (_l, m, u) => {
    const r = await e()[m](u);
    expect(r.status).toBe(403);
  });
  test("[-] GET /locations/path of a colleague -> 403", async () => {
    expect((await e().get(`/locations/path?employeeId=${A.people.emp2.userId}&date=2026-10-14`)).status).toBe(403);
  });
  test("[-] GET /locations/routes of a colleague -> 403", async () => {
    expect((await e().get(`/locations/routes?employeeId=${A.people.emp2.userId}`)).status).toBe(403);
  });
  test("[+] admin-correct / approve / import / shift create / holiday create -> 403", async () => {
    const id = await recId(A.people.emp2);
    expect((await e().patch("/attendance/admin-correct", { userId: A.people.emp2.userId, date: "2026-10-13", statusOverride: "Full Day" })).status).toBe(403);
    expect((await e().patch(`/attendance/${id}/approve`)).status).toBe(403);
    expect((await e().post("/attendance/import", { rows: [{ employee: "x", date: "2026-10-01" }] })).status).toBe(403);
    expect((await e().post("/shifts", { name: "Emp shift", startTime: "09:00", endTime: "10:00" })).status).toBe(403);
    expect((await e().post("/holidays", { name: "Emp hol", date: "2026-11-30" })).status).toBe(403);
  });
  test("[+] own data works: today / history / own record by id", async () => {
    expect((await e().get("/attendance/today")).status).toBe(200);
    expect((await e().get("/attendance/history?month=10&year=2026")).body.data.length).toBeGreaterThan(0);
    expect((await e().get(`/attendance/${await recId(A.people.emp1)}`)).status).toBe(200);
  });
  test("[+] colleague's record by id -> 403", async () => {
    expect((await e().get(`/attendance/${await recId(A.people.emp2)}`)).status).toBe(403);
  });
  test("[-] suspected #8: regularize a COLLEAGUE's attendance -> 403", async () => {
    const r = await e().post(`/attendance/${await recId(A.people.emp2)}/regularize`, { reason: "not mine" });
    expect(r.status).toBe(403);
  });
});

describe("Role-based access: page-only permission holders", () => {
  test("[+] Attendance officer (HRMS role view_attendance) can list, correct and approve", async () => {
    const o = api(A.people.attOfficer.token);
    expect((await o.get("/attendance?date=2026-10-14")).status).toBe(200);
    expect((await o.patch("/attendance/admin-correct", { userId: A.people.emp2.userId, date: "2026-10-13", punchInTime: "09:30", punchOutTime: "18:30" })).status).toBe(200);
    expect((await o.patch(`/attendance/${await recId(A.people.emp1)}/approve`)).status).toBe(200);
  });
  test("[-] suspected #1: staff given 'HRMS Attendance' in Setup > Roles (screen permission) can use the Correct API", async () => {
    const r = await api(A.people.attScreenOnly.token).patch("/attendance/admin-correct", { userId: A.people.emp2.userId, date: "2026-10-12", punchInTime: "09:30", punchOutTime: "18:30" });
    expect(r.status).toBe(200);
  });
  test("[+] Attendance officer cannot manage shifts (403) and cannot create holidays (403)", async () => {
    const o = api(A.people.attOfficer.token);
    expect((await o.post("/shifts", { name: "AO shift", startTime: "09:00", endTime: "10:00" })).status).toBe(403);
    expect((await o.post("/holidays", { name: "AO hol", date: "2026-11-30" })).status).toBe(403);
  });
  test("[+] Shift manager can create / edit / assign shifts", async () => {
    const s = api(A.people.shiftMgr.token);
    const c = await s.post("/shifts", { name: "SM shift", startTime: "08:00", endTime: "17:00" });
    expect(c.status).toBe(201);
    expect((await s.patch(`/shifts/${c.body.data._id}`, { lateGraceMinutes: 10 })).status).toBe(200);
    expect((await s.post(`/shifts/${c.body.data._id}/assign`, { userIds: [A.people.emp2.userId] })).body.data.modified).toBe(1);
  });
  test("[+] Shift manager cannot correct attendance (403)", async () => {
    expect((await api(A.people.shiftMgr.token).patch("/attendance/admin-correct", { userId: A.people.emp2.userId, date: "2026-10-11", statusOverride: "Full Day" })).status).toBe(403);
  });
});

describe("Branch supervisor (supervises HQ only)", () => {
  const s = () => api(A.people.supervisor.token);
  test("[+] attendance list shows only HQ staff + self", async () => {
    const r = await s().get("/attendance?date=2026-10-14");
    expect(r.status).toBe(200);
    const ids = r.body.data.map((x) => String(x.userId?._id || x.userId));
    expect(ids).toContain(A.people.emp1.userId);
    expect(ids).not.toContain(A.people.otherBranch.userId);
  });
  test("[+] can approve HQ staff, cannot approve other-branch staff", async () => {
    expect((await s().patch(`/attendance/${await recId(A.people.emp2)}/approve`)).status).toBe(200);
    expect((await s().patch(`/attendance/${await recId(A.people.otherBranch)}/approve`)).status).toBe(403);
  });
  test("[+] cannot correct other-branch staff (403)", async () => {
    expect((await s().patch("/attendance/admin-correct", { userId: A.people.otherBranch.userId, date: "2026-10-13", statusOverride: "Full Day" })).status).toBe(403);
  });
  test("[-] Live Tracking latest locations narrowed to own branch", async () => {
    const r = await s().get("/locations/latest");
    const ids = (r.body.data || []).map((x) => String(x.userId));
    expect(ids).not.toContain(A.people.otherBranch.userId);
  });
});

describe("Security: company separation", () => {
  const b = () => api(B.people.admin.token);
  test("[+] Company B admin cannot read A's attendance record by id (403/404)", async () => {
    expect([403, 404]).toContain((await b().get(`/attendance/${await recId(A.people.emp1)}`)).status);
  });
  test("[+] Company B admin list never contains A staff", async () => {
    const r = await b().get("/attendance?date=2026-10-14");
    expect(r.body.data.map((x) => String(x.userId?._id || x.userId))).not.toContain(A.people.emp1.userId);
  });
  test("[+] B admin cannot correct / approve A staff", async () => {
    expect((await b().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-10-13", statusOverride: "Absent" })).status).toBe(403);
    expect([403, 404]).toContain((await b().patch(`/attendance/${await recId(A.people.emp1)}/approve`)).status);
  });
  test("[-] B admin cannot regularize A's attendance record", async () => {
    const r = await b().post(`/attendance/${await recId(A.people.emp1)}/regularize`, { reason: "cross-tenant" });
    expect([403, 404]).toContain(r.status);
  });
  test("[+] shifts: B cannot read / edit / delete A's shift (404); assigning A's staff to B's shift changes 0", async () => {
    const id = String(A.shifts.general);
    expect((await b().get(`/shifts/${id}`)).status).toBe(404);
    expect((await b().patch(`/shifts/${id}`, { name: "Hacked" })).status).toBe(404);
    expect((await b().del(`/shifts/${id}`)).status).toBe(404);
    const r = await b().post(`/shifts/${B.shifts.general}/assign`, { userIds: [A.people.emp1.userId] });
    expect(r.body.data.modified).toBe(0);
  });
  test("[+] shift create cannot be forced into another tenant via tenant_id in body", async () => {
    const r = await b().post("/shifts", { name: "Smuggle", startTime: "09:00", endTime: "10:00", tenant_id: A.tenantId });
    expect(String(r.body.data.tenant_id)).toBe(B.tenantId);
  });
  test("[+] holidays: B cannot read / edit / delete A's holiday (404)", async () => {
    at("2026-10-14T12:00:00");
    const h = await api(A.people.admin.token).post("/holidays", { name: "A only", date: "2026-11-25" });
    const id = h.body.data._id;
    expect((await b().get(`/holidays/${id}`)).status).toBe(404);
    expect((await b().put(`/holidays/${id}`, { name: "Hacked" })).status).toBe(404);
    expect((await b().del(`/holidays/${id}`)).status).toBe(404);
    expect((await b().get("/holidays?year=2026")).body.data.map((x) => x.name)).not.toContain("A only");
  });
  test("[+] locations: B cannot read A employee's path (404)", async () => {
    expect((await b().get(`/locations/path?employeeId=${A.people.emp1.userId}`)).status).toBe(404);
  });
  test("[-] geofence audit: A admin passing ?userId=<B employee> must not see B's audit rows", async () => {
    const GeofenceAudit = require("../models/geofence_audit_model");
    await GeofenceAudit.create({ userId: B.people.emp1.userId, date: "2026-10-14", time: "10:00:00", radiusM: 200, trigger: "client" });
    const r = await api(A.people.admin.token).get(`/locations/geofence-audit?userId=${B.people.emp1.userId}`);
    expect(r.body.total).toBe(0);
  });
  test("[-] NoSQL injection: geofence audit ?userId[$ne]=x must stay inside the company", async () => {
    const r = await api(A.people.admin.token).get("/locations/geofence-audit?userId[$ne]=000000000000000000000000");
    const ids = (r.body.data || []).map((x) => String(x.userId?._id || x.userId));
    expect(ids).not.toContain(B.people.emp1.userId);
  });
  test("[+] NoSQL injection: /attendance?userId[$ne]= / hrmsBranchId[$ne]= stays inside the company, never 500", async () => {
    const r1 = await api(A.people.admin.token).get("/attendance?userId[$ne]=x");
    const r2 = await api(A.people.admin.token).get("/attendance?hrmsBranchId[$ne]=x&date=2026-10-14");
    expect(r1.status).toBeLessThan(500);
    expect(r2.status).toBeLessThan(500);
    const ids = [...(r1.body.data || []), ...(r2.body.data || [])].map((x) => String(x.userId?._id || x.userId));
    expect(ids).not.toContain(B.people.emp1.userId);
  });
  test("[+] bad ObjectId in path -> 4xx not 500 (GET /attendance/not-an-id, /shifts/not-an-id)", async () => {
    const r = await api(A.people.admin.token).get("/attendance/not-an-id");
    const s = await api(A.people.admin.token).get("/shifts/not-an-id");
    console.log(`[BAD ID] attendance=${r.status} shifts=${s.status}`);
    expect(r.status).toBeLessThan(500);
    expect(s.status).toBeLessThan(500);
  });
  test("[-] tracking token (scope location_tracking, 36 h) must not unlock non-tracking APIs", async () => {
    const t = await api(A.people.admin.token).post("/locations/tracking-token", {});
    expect(t.status).toBe(200);
    const r = await api(t.body.token).get("/attendance?date=2026-10-14");
    expect(r.status).toBe(403);
  });
});

describe("Socket.IO rooms and broadcasts", () => {
  const connect = (opts = {}) => new Promise((resolve, reject) => {
    const s = ioClient(base, { transports: ["websocket"], forceNew: true, reconnection: false, ...opts });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => resolve({ refused: true, error: e.message, disconnect() {} }));
    setTimeout(() => reject(new Error("socket timeout")), 5000);
  });
  test("[-] a socket with NO token is refused", async () => {
    const s = await connect();
    expect(s.refused).toBe(true);
    s.disconnect();
  });
  test("[-] Company B's socket must not receive Company A's attendance_update", async () => {
    const s = await connect({ auth: { token: B.people.admin.token } });
    const got = [];
    s.on("attendance_update", (p) => got.push(p));
    await punchIn(A.people.emp1, "2026-10-15T09:30:00");
    await sleep(400);
    s.disconnect();
    console.log(`[SOCKET] B received attendance_update from A: ${JSON.stringify(got)}`);
    expect(got.filter((p) => p.userId === A.people.emp1.userId).length).toBe(0);
  });
  test("[-] Company B's socket must not receive Company A's live location (name + lat/lng)", async () => {
    const s = await connect({ auth: { token: B.people.admin.token } });
    const got = [];
    s.on("location_update", (p) => got.push(p));
    at("2026-10-15T10:00:00");
    await api(A.people.emp1.token).post("/locations/update", { lat: 23.03, lng: 72.58, accuracy: 5 });
    await sleep(500);
    s.disconnect();
    console.log(`[SOCKET] B received location_update: ${JSON.stringify(got).slice(0, 300)}`);
    expect(got.length).toBe(0);
  });
  test("[-] index.js 'join': an unauthenticated socket can join another company's tenant room", async () => {
    const s = await connect();
    if (s.refused) return; // would be the expected behaviour
    s.emit("join", `tenant-${A.tenantId}`);
    s.emit("join-room", "global-tracking");
    await sleep(300);
    const inTenantRoom = srv.io.sockets.adapter.rooms.get(`tenant-${A.tenantId}`)?.has(s.id);
    const inGlobal = srv.io.sockets.adapter.rooms.get("global-tracking")?.has(s.id);
    s.disconnect();
    console.log(`[SOCKET] anon joined tenant room=${!!inTenantRoom} global-tracking=${!!inGlobal}`);
    expect(!!inTenantRoom).toBe(false);
    expect(!!inGlobal).toBe(false);
  });
  test("[-] a client can spoof a location_update that is relayed to every global-tracking listener", async () => {
    const viewer = await connect();
    const attacker = await connect();
    if (viewer.refused) return;
    viewer.emit("join-room", "global-tracking");
    await sleep(200);
    const got = [];
    viewer.on("location_update", (p) => got.push(p));
    attacker.emit("location_update", { userId: A.people.emp2.userId, lat: 1.23, lng: 4.56 });
    await sleep(300);
    viewer.disconnect(); attacker.disconnect();
    expect(got.length).toBe(0);
  });
  test("[-] an unauthenticated socket can trigger force_location_update for any employee", async () => {
    const s = await connect();
    if (s.refused) return;
    const reply = await new Promise((resolve) => {
      s.on("ping_status", resolve);
      s.emit("force_location_update_request", { employeeId: A.people.emp2.userId });
      setTimeout(() => resolve(null), 1500);
    });
    s.disconnect();
    console.log(`[SOCKET] force_location_update reply: ${JSON.stringify(reply)}`);
    expect(reply).toBeNull();
  });
});

describe("Face Attendance / Kiosk (add-on face_attendance)", () => {
  const adm = () => api(A.people.admin.token);
  test("[+] company without the add-on: /face/status 403 FEATURE_DISABLED, /face/me enabled=false", async () => {
    expect((await api(B.people.admin.token).get("/face/status")).body.code).toBe("FEATURE_DISABLED");
    expect((await api(B.people.emp1.token).get("/face/me")).body.data.enabled).toBe(false);
  });
  test("[+] employee without attendance permission -> 403 on status / enrol / kiosk", async () => {
    const e = api(A.people.emp1.token);
    expect((await e.get("/face/status")).status).toBe(403);
    expect((await e.post(`/face/enrollments/${A.people.emp1.userId}`, imgForm("photos", ["FACE:self"]))).status).toBe(403);
    expect((await e.post("/face/kiosk/punch", imgForm("frame", ["FACE:self"]))).status).toBe(403);
  });
  test("[+] attendance officer -> /face/status 200", async () => {
    expect((await api(A.people.attOfficer.token).get("/face/status")).status).toBe(200);
  });
  test.each([
    ["0 photos", [], 400],
    ["no face", ["NOFACE"], 400],
    ["two faces in one photo", ["FACES:alice,bob"], 400],
    ["face too small", ["SMALL:alice"], 400],
    ["unreadable image", ["BAD"], 400],
    ["6 photos (max 5)", Array(6).fill("FACE:alice"), 400],
  ])("[-] enrol: %s -> 400", async (_l, photos, expected) => {
    const r = await adm().post(`/face/enrollments/${A.people.faceEmp.userId}`, imgForm("photos", photos));
    expect(r.status).toBe(expected);
  });
  test("[+] enrol faceEmp with 2 photos of 'alice' -> 200", async () => {
    const r = await adm().post(`/face/enrollments/${A.people.faceEmp.userId}`, imgForm("photos", ["FACE:alice", "FACE:alice"]));
    expect(r.status).toBe(200);
    expect(r.body.data.photoCount).toBe(2);
  });
  test("[+] same face for a second person -> 409", async () => {
    expect((await adm().post(`/face/enrollments/${A.people.emp2.userId}`, imgForm("photos", ["FACE:alice"]))).status).toBe(409);
  });
  test("[+] cross-company enrol (A admin -> Rudraverse employee) -> 404", async () => {
    expect((await adm().post(`/face/enrollments/${R.people.emp1.userId}`, imgForm("photos", ["FACE:zed"]))).status).toBe(404);
  });
  test("[+] kiosk recognise: matches alice, ignores unknown; another company's kiosk does not see alice", async () => {
    const fd = imgForm("frame", ["FACES:alice,stranger"]);
    const r = await adm().post("/face/kiosk/recognize", fd);
    expect(r.body.data.faces[0].match.userId).toBe(A.people.faceEmp.userId);
    expect(r.body.data.faces[1].match).toBeNull();
    const rr = await api(R.people.admin.token).post("/face/kiosk/recognize", imgForm("frame", ["FACE:alice"]));
    expect(rr.body.data.faces[0].match).toBeNull();
  });
  test("[+] kiosk punch: in -> cooldown skip -> after 121 s decides punch-out", async () => {
    at("2026-10-16T09:30:00");
    const k = (c) => adm().post("/face/kiosk/punch", (() => { const fd = imgForm("frame", [c]); fd.append("userId", A.people.faceEmp.userId); return fd; })());
    const r1 = await k("FACE:alice");
    expect(r1.status).toBe(200);
    expect(r1.body.action).toBe("punch-in");
    at("2026-10-16T09:31:00");
    const r2 = await k("FACE:alice");
    expect(r2.body.skipped).toBe(true);
    at("2026-10-16T09:32:01");
    const r3 = await k("FACE:alice");
    expect(r3.body.action).toBe("punch-out");
    expect(r3.status).toBe(200);
  });
  test("[+] kiosk punch with a different face -> 409; face service down -> 503", async () => {
    at("2026-10-17T09:30:00");
    const fd = imgForm("frame", ["FACE:bob"]); fd.append("userId", A.people.faceEmp.userId);
    expect((await adm().post("/face/kiosk/punch", fd)).status).toBe(409);
    process.env.FACE_SERVICE_DOWN = "1";
    const fd2 = imgForm("frame", ["FACE:alice"]); fd2.append("userId", A.people.faceEmp.userId);
    const r = await adm().post("/face/kiosk/punch", fd2);
    process.env.FACE_SERVICE_DOWN = "";
    expect(r.status).toBe(503);
  });
  test("[+] selfie punch: enrolled employee with another person's face -> 403 faceMismatch; no face -> 403", async () => {
    const r1 = await punchIn(A.people.faceEmp, "2026-10-18T09:30:00", IN, "FACE:bob");
    expect(r1.status).toBe(403);
    expect(r1.body.faceMismatch).toBe(true);
    expect((await punchIn(A.people.faceEmp, "2026-10-18T09:31:00", IN, "NOFACE")).status).toBe(403);
  });
  test("[-] suspected #20: enrolled employee punching in WITHOUT a selfie must be face-checked (expect 4xx)", async () => {
    const r = await punchIn(A.people.faceEmp, "2026-10-18T09:32:00", IN);
    console.log(`[SELFIE] no-selfie punch status=${r.status} selfieVerificationStatus=${r.body?.data?.selfieVerificationStatus}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[-] a punch with no selfie at all must never be stored as selfie 'verified'", async () => {
    const r = await punchIn(A.people.emp2, "2026-10-19T09:30:00", IN);
    expect(r.body.data.selfieVerificationStatus).not.toBe("verified");
  });
  test("[+] selfie punch with own face -> 201 verified", async () => {
    const r = await punchIn(A.people.faceEmp, "2026-10-19T09:30:00", IN, "FACE:alice");
    expect(r.status).toBe(201);
    expect(r.body.data.selfieVerificationStatus).toBe("verified");
  });
  test("[+] remove enrolment -> 200; then status shows 0 enrolled", async () => {
    expect((await adm().del(`/face/enrollments/${A.people.faceEmp.userId}`)).status).toBe(200);
    expect((await adm().get("/face/status")).body.data.enrolled).toBe(0);
  });
});
