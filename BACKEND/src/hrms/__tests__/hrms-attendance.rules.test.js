// HRMS Part B — Attendance business rules, field rules and negative cases.
// In-memory MongoDB + backend on 127.0.0.1:5207 (see testUtils/hrms-attendance.harness.js).
// Only the JS Date is faked (jest.setSystemTime) so late / overtime / overnight /
// nightly-job scenarios run at fixed IST wall times. Every test asserts the
// EXPECTED rule (PROPOSED rules treated as real); a failing test = a finding.
// Hand-calculated numbers are in the test names / comments.
const fs = require("fs");
const path = require("path");
const H = require("../../testUtils/hrms-attendance.harness");

jest.setTimeout(180000);
const NOT_FAKED = ["hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"];

let db, T, srv, api, A, B, P, Attendance, GeofenceAudit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (s) => jest.setSystemTime(H.ist(s));
const IN = { lat: H.HQ.lat, lng: H.HQ.lng, accuracy: 10 };
const OUT1KM = { lat: H.offsetLat(1000), lng: H.HQ.lng, accuracy: 10 };
const punchIn = (who, time, loc = IN, selfie) => { at(time); return api(who.token).post("/attendance/punch-in", H.punchForm(loc, selfie)); };
const punchOut = (who, time, loc = IN, selfie) => { at(time); return api(who.token).post("/attendance/punch-out", H.punchForm(loc, selfie)); };
const lunchIn = (who, time, loc = IN) => { at(time); return api(who.token).post("/attendance/lunch-in", loc); };
const lunchOut = (who, time, loc = IN) => { at(time); return api(who.token).post("/attendance/lunch-out", loc); };
const rec = (who, date) => Attendance.findOne({ userId: who.userId, date }).lean();

beforeAll(async () => {
  H.installStubs();
  db = await H.startDb();
  T = await H.seedAll();
  ({ A, B, P } = T);
  srv = H.buildApp();
  api = H.makeClient((await H.listen(srv.server)) + "/api/hrms");
  Attendance = require("../models/attendance_model");
  GeofenceAudit = require("../models/geofence_audit_model");
  jest.useFakeTimers({ doNotFake: NOT_FAKED });
});
afterAll(async () => {
  jest.useRealTimers();
  await sleep(300);
  srv.io.close();
  await new Promise((r) => srv.server.close(r));
  await db.mongoose.disconnect();
  await db.mongod.stop();
});

describe("Rule 1-2: GPS accuracy and geofence on punch-in", () => {
  test("[-] accuracy 151 m is rejected (403)", async () => {
    const r = await punchIn(A.people.emp2, "2026-10-01T09:30:00", { ...IN, accuracy: 151 });
    expect(r.status).toBe(403);
  });
  test("[+] accuracy exactly 150 m is allowed (201)", async () => {
    expect((await punchIn(A.people.emp2, "2026-10-01T09:31:00", { ...IN, accuracy: 150 })).status).toBe(201);
  });
  test("[+] inside geofence (199 m from HQ, radius 200) -> 201, geoStatus inside_geofence", async () => {
    const r = await punchIn(A.people.emp1, "2026-10-01T09:30:00", { lat: H.offsetLat(199), lng: H.HQ.lng, accuracy: 10 });
    expect(r.status).toBe(201);
    expect(r.body.data.geoStatus).toBe("inside_geofence");
  });
  test("[-] outside geofence (300 m, radius 200) -> 403 geoFenceViolation", async () => {
    const r = await punchIn(A.people.emp1, "2026-10-02T09:30:00", { lat: H.offsetLat(300), lng: H.HQ.lng, accuracy: 10 });
    expect(r.status).toBe(403);
    expect(r.body.geoFenceViolation).toBe(true);
    expect(await rec(A.people.emp1, "2026-10-02")).toBeNull();
  });
  test("[-] PROPOSED rule 2: punch-in with NO GPS location must not skip the geofence (expect 4xx)", async () => {
    at("2026-10-03T09:30:00");
    const r = await api(A.people.emp1.token).post("/attendance/punch-in", H.punchForm({}));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
  test("[-] lat/lng given as text ('abc') -> 400, never 500", async () => {
    const r = await punchIn(A.people.empNoCoords, "2026-10-03T09:30:00", { lat: "abc", lng: "xyz", accuracy: 10 });
    expect(r.status).toBe(400);
  });
  test("[-] out-of-range coordinates (lat 999) -> 400", async () => {
    const r = await punchIn(A.people.empFenceOff, "2026-10-03T09:30:00", { lat: 999, lng: 999, accuracy: 10 });
    expect(r.status).toBe(400);
  });
  test("[+] Rudraverse tenant follows exactly the same geofence rules (inside 201 / outside 403)", async () => {
    expect((await punchIn(T.R.people.emp1, "2026-10-01T09:30:00")).status).toBe(201);
    expect((await punchIn(T.R.people.emp2, "2026-10-01T09:30:00", { lat: H.offsetLat(300), lng: H.HQ.lng, accuracy: 10 })).status).toBe(403);
  });
});

describe("Rule 3: late minutes (shift 09:30, late grace 15)", () => {
  test("[+] 09:45 -> lateMinutes 0 (exactly at grace is not late)", async () => {
    const r = await punchIn(A.people.emp1, "2026-10-05T09:45:00");
    expect(r.status).toBe(201);
    expect(r.body.data.lateMinutes).toBe(0);
  });
  test("[+] 09:46 -> lateMinutes 16 (counted from shift start)", async () => {
    const r = await punchIn(A.people.emp1, "2026-10-06T09:46:00");
    expect(r.body.data.lateMinutes).toBe(16);
  });
});

describe("Rule 4-6: sessions, lunch state machine", () => {
  const w = () => A.people.emp2;
  test("[-] re-punch-in while a session is open -> 400", async () => {
    expect((await punchIn(w(), "2026-10-07T09:30:00")).status).toBe(201);
    expect((await punchIn(w(), "2026-10-07T09:35:00")).status).toBe(400);
  });
  test("[-] lunch-out with no lunch started -> 400", async () => {
    expect((await lunchOut(w(), "2026-10-07T12:00:00")).status).toBe(400);
  });
  test("[+] lunch-in inside session -> 200; second lunch-in while open -> 400", async () => {
    expect((await lunchIn(w(), "2026-10-07T13:00:00")).status).toBe(200);
    expect((await lunchIn(w(), "2026-10-07T13:05:00")).status).toBe(400);
  });
  test("[-] punch-out while lunch is open -> 400", async () => {
    expect((await punchOut(w(), "2026-10-07T13:10:00")).status).toBe(400);
  });
  test("[+] lunch-out -> 200; second lunch on same day -> 400", async () => {
    expect((await lunchOut(w(), "2026-10-07T13:30:00")).status).toBe(200);
    expect((await lunchIn(w(), "2026-10-07T14:00:00")).status).toBe(400);
  });
  test("[+] 5 sessions allowed per day, 6th refused (400)", async () => {
    expect((await punchOut(w(), "2026-10-07T14:30:00")).status).toBe(200);
    const times = [["15:00", "15:10"], ["15:20", "15:30"], ["15:40", "15:50"], ["16:00", "16:10"]];
    for (const [i, o] of times) {
      expect((await punchIn(w(), `2026-10-07T${i}:00`)).status).toBe(200);
      expect((await punchOut(w(), `2026-10-07T${o}:00`)).status).toBe(200);
    }
    const r = await punchIn(w(), "2026-10-07T16:20:00");
    expect(r.status).toBe(400);
    expect((await rec(w(), "2026-10-07")).sessions.length).toBe(4);
  });
  test("[-] lunch-in with no attendance record -> 404/400, not 500", async () => {
    const r = await lunchIn(A.people.emp2, "2026-10-08T13:00:00");
    expect([400, 404]).toContain(r.status);
  });
  test("[-] lunch-in after the day's punch-out (no open session) -> 400", async () => {
    const e = A.people.empNoLunch;
    await punchIn(e, "2026-10-08T09:30:00");
    await punchOut(e, "2026-10-08T10:00:00");
    expect((await lunchIn(e, "2026-10-08T10:05:00")).status).toBe(400);
  });
});

describe("Rule 5: punch-out geofence and field roles", () => {
  test("[-] office employee punching out 1 km away -> 403", async () => {
    await punchIn(A.people.emp1, "2026-10-08T09:30:00");
    const r = await punchOut(A.people.emp1, "2026-10-08T18:30:00", OUT1KM);
    expect(r.status).toBe(403);
  });
  test("[+] field executive may punch out 1 km away -> 200", async () => {
    await punchIn(A.people.field, "2026-10-08T09:30:00");
    expect((await punchOut(A.people.field, "2026-10-08T18:30:00", OUT1KM)).status).toBe(200);
  });
  test("[-] field executive punch-IN 1 km away should follow the same exemption (expect 201)", async () => {
    const r = await punchIn(A.people.field, "2026-10-09T09:30:00", OUT1KM);
    expect(r.status).toBe(201);
  });
});

describe("Rule 7: total hours and Full/Half Day (General 09:30-18:30, auto lunch 60 -> expected 8h)", () => {
  test("[C] auto lunch: 09:30-18:30 -> 8.00 h, Full Day", async () => {
    const e = A.people.emp1;
    await punchIn(e, "2026-10-09T09:30:00");
    const r = await punchOut(e, "2026-10-09T18:30:00");
    expect(r.status).toBe(200);
    expect(r.body.data.totalHours).toBeCloseTo(8, 2);
    expect(r.body.data.status).toBe("Full Day");
  });
  test("[C] auto lunch: 09:30-17:30 -> 7.00 h, Half Day", async () => {
    const e = A.people.emp2;
    await punchIn(e, "2026-10-09T09:30:00");
    const r = await punchOut(e, "2026-10-09T17:30:00");
    expect(r.body.data.totalHours).toBeCloseTo(7, 2);
    expect(r.body.data.status).toBe("Half Day");
  });
  test("[C] punch lunch 80 min: 9h - 80m = 7.67 h, Half Day, lunchOverLimit", async () => {
    const e = A.people.empPunchLunch;
    await punchIn(e, "2026-10-09T09:30:00");
    await lunchIn(e, "2026-10-09T13:00:00");
    await lunchOut(e, "2026-10-09T14:20:00");
    const r = await punchOut(e, "2026-10-09T18:30:00");
    expect(r.body.data.totalHours).toBeCloseTo(7.6667, 2);
    expect(r.body.data.status).toBe("Half Day");
    expect(r.body.data.lunchOverLimit).toBe(true);
  });
  test("[C] punch lunch 40 min: still 60 deducted -> 8.00 h, Full Day", async () => {
    const e = A.people.empPunchLunch;
    await punchIn(e, "2026-10-10T09:30:00");
    await lunchIn(e, "2026-10-10T13:00:00");
    await lunchOut(e, "2026-10-10T13:40:00");
    const r = await punchOut(e, "2026-10-10T18:30:00");
    expect(r.body.data.totalHours).toBeCloseTo(8, 2);
    expect(r.body.data.status).toBe("Full Day");
  });
  test("[C] no lunch config: 09:30-18:30 with 30-min punched lunch -> 8.5 h of 9 h -> Half Day", async () => {
    const e = A.people.empNoLunch;
    await punchIn(e, "2026-10-10T09:30:00");
    await lunchIn(e, "2026-10-10T13:00:00");
    await lunchOut(e, "2026-10-10T13:30:00");
    const r = await punchOut(e, "2026-10-10T18:30:00");
    expect(r.body.data.totalHours).toBeCloseTo(8.5, 2);
    expect(r.body.data.status).toBe("Half Day");
  });
  test("[C] multiple sessions add up: 09:30-13:30 + 14:30-18:30 (auto lunch 60) -> 7 h Half Day", async () => {
    const e = A.people.emp1;
    await punchIn(e, "2026-10-10T09:30:00");
    await punchOut(e, "2026-10-10T13:30:00");
    await punchIn(e, "2026-10-10T14:30:00");
    const r = await punchOut(e, "2026-10-10T18:30:00");
    expect(r.body.data.totalHours).toBeCloseTo(7, 2);
    expect(r.body.data.status).toBe("Half Day");
  });
});

describe("Rule 8: late allowance (3 per month) downgrades Full Day to Half Day", () => {
  beforeAll(async () => {
    const e = A.people.dupName1;
    const rows = ["2026-10-12", "2026-10-13", "2026-10-14"].map((date) => ({
      userId: new db.mongoose.Types.ObjectId(e.userId), date, punchIn: { time: "09:50:00" }, punchOut: { time: "19:00:00" },
      lateMinutes: 20, status: "Full Day", totalHours: 8.5, createdAt: new Date(), updatedAt: new Date(),
    }));
    await Attendance.collection.insertMany(rows.slice(0, 2));
    // 3rd late day goes through the API.
  });
  test("[C] 3rd late day (09:50, full hours) stays Full Day", async () => {
    const e = A.people.dupName1;
    await punchIn(e, "2026-10-14T09:50:00");
    const r = await punchOut(e, "2026-10-14T19:00:00");
    expect(r.body.data.lateMinutes).toBe(20);
    expect(r.body.data.status).toBe("Full Day");
  });
  test("[C] 4th late day (allowed 3) with full hours -> Half Day", async () => {
    const e = A.people.dupName1;
    await punchIn(e, "2026-10-15T09:50:00");
    const r = await punchOut(e, "2026-10-15T19:00:00");
    expect(r.body.data.status).toBe("Half Day");
  });
});

describe("Rule 9: overtime / early-out / overnight", () => {
  test("[C] out 19:10 -> overtime 40 min (> 30 grace)", async () => {
    const e = A.people.emp2;
    await punchIn(e, "2026-10-12T09:30:00");
    expect((await punchOut(e, "2026-10-12T19:10:00")).body.data.overtimeMinutes).toBe(40);
  });
  test("[C] out 18:55 -> overtime 0 (25 <= 30 grace)", async () => {
    const e = A.people.emp2;
    await punchIn(e, "2026-10-13T09:30:00");
    expect((await punchOut(e, "2026-10-13T18:55:00")).body.data.overtimeMinutes).toBe(0);
  });
  test("[C] out 18:10 -> earlyOut 20 min (> 15 grace); 18:20 -> 0", async () => {
    await punchIn(A.people.emp1, "2026-10-12T09:30:00");
    expect((await punchOut(A.people.emp1, "2026-10-12T18:10:00")).body.data.earlyOutMinutes).toBe(20);
    await punchIn(A.people.emp1, "2026-10-13T09:30:00");
    expect((await punchOut(A.people.emp1, "2026-10-13T18:20:00")).body.data.earlyOutMinutes).toBe(0);
  });
  test("[-] overnight shift 22:00-06:00: punch-in 22:00, punch-out next morning 06:00 -> 200, 8 h Full Day on the start date", async () => {
    const e = A.people.night;
    expect((await punchIn(e, "2026-10-14T22:00:00")).status).toBe(201);
    const r = await punchOut(e, "2026-10-15T06:00:00");
    expect(r.status).toBe(200);
    const d = await rec(e, "2026-10-14");
    expect(d.punchOut?.time).toBeTruthy();
    expect(d.totalHours).toBeCloseTo(8, 2);
    expect(d.status).toBe("Full Day");
  });
  test("[-] overnight shift: punch-in 00:30 (2.5 h after a 22:00 start) is counted late (expect lateMinutes 150)", async () => {
    const r = await punchIn(A.people.night, "2026-10-17T00:30:00");
    expect(r.status).toBe(201);
    expect(r.body.data.lateMinutes).toBe(150);
  });
});

describe("Rule 10: nightly job closes forgotten punches", () => {
  const { closeForgottenPunches } = require("../jobs/attendance_jobs");
  test("[C] day shift left open on 10-20 -> closed at shift end 18:30 by the 04:00 job; reports the status it gets", async () => {
    const e = A.people.noAccess;
    await punchIn(e, "2026-10-20T09:35:00");
    at("2026-10-21T04:00:00");
    const out = await closeForgottenPunches({ userId: new db.mongoose.Types.ObjectId(e.userId) });
    const d = await rec(e, "2026-10-20");
    console.log(`[NIGHTLY JOB] closed=${out.closed} punchOut=${d.punchOut?.time} reason=${d.punchOut?.closeReason} status=${d.status} hours=${d.totalHours}`);
    expect(d.punchOut.time).toBe("18:30:00");
    expect(d.punchOut.closeReason).toBe("shift_end");
    // An unconfirmed (forgotten) punch-out should NOT be credited as a Full Day.
    expect(d.status).not.toBe("Full Day");
  });
  test("[-] overnight shift still running at 04:00 (ends 06:00) must NOT be closed by the job", async () => {
    const e = A.people.night;
    await punchIn(e, "2026-10-20T22:00:00");
    at("2026-10-21T04:00:00");
    await closeForgottenPunches({ userId: new db.mongoose.Types.ObjectId(e.userId) });
    const d = await rec(e, "2026-10-20");
    console.log(`[NIGHTLY JOB overnight] punchOut=${d.punchOut?.time} hours=${d.totalHours} status=${d.status}`);
    expect(d.punchOut?.time).toBeFalsy();
  });
  test("[-] the nightly job is actually scheduled by the running server (index.js starts the HRMS scheduler)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../index.js"), "utf8");
    expect(/hrms\/utils\/scheduler|closeForgottenPunches|scheduleAttendanceCleanup/.test(src)).toBe(true);
  });
});

describe("Rule 11: auto punch-out on leaving the geofence", () => {
  const sendFix = async (who, time, loc) => {
    at(time);
    const r = await api(who.token).post("/locations/update", { lat: loc.lat, lng: loc.lng, accuracy: 10 });
    await sleep(250); // geofence check runs after the response
    return r;
  };
  test("[+] background: 5 fixes 1 km away over 2 min -> auto punch-out + Geofence Audit row (trigger background)", async () => {
    const e = A.people.emp1;
    await punchIn(e, "2026-10-22T09:30:00");
    for (const s of ["09:35:00", "09:35:30", "09:36:00", "09:36:30", "09:37:00"]) await sendFix(e, `2026-10-22T${s}`, OUT1KM);
    const d = await rec(e, "2026-10-22");
    expect(d.autoPunchOut).toBe(true);
    expect(d.punchOut.time).toBe("09:37:00");
    const audit = await GeofenceAudit.findOne({ userId: e.userId, date: "2026-10-22" }).lean();
    expect(audit).toBeTruthy();
    expect(audit.trigger).toBe("background");
    expect(audit.fixesInWindow).toBe(5);
  });
  test("[+] median ignores one bad fix: 4 inside + 1 outside -> stays punched in", async () => {
    const e = A.people.emp2;
    await punchIn(e, "2026-10-22T09:30:00");
    const seq = [IN, IN, OUT1KM, IN, IN];
    for (let i = 0; i < 5; i++) await sendFix(e, `2026-10-22T09:3${5 + Math.floor(i / 2)}:${i % 2 ? "30" : "00"}`, seq[i]);
    expect((await rec(e, "2026-10-22")).punchOut?.time).toBeFalsy();
  });
  test("[+] on lunch break: 5 fixes outside -> no auto punch-out", async () => {
    const e = A.people.empPunchLunch;
    await punchIn(e, "2026-10-22T09:30:00");
    await lunchIn(e, "2026-10-22T13:00:00");
    for (const s of ["13:05:00", "13:05:30", "13:06:00", "13:06:30", "13:07:00"]) await sendFix(e, `2026-10-22T${s}`, OUT1KM);
    expect((await rec(e, "2026-10-22")).punchOut?.time).toBeFalsy();
  });
  test("[-] PROPOSED: client auto-punch-out must NEVER fire for a branch without coordinates", async () => {
    const e = A.people.empNoCoords;
    await punchIn(e, "2026-10-22T09:30:00");
    at("2026-10-22T09:40:00");
    const r = await api(e.token).post("/attendance/auto-punch-out", OUT1KM);
    const d = await rec(e, "2026-10-22");
    const audits = await GeofenceAudit.countDocuments({ userId: e.userId });
    console.log(`[AUTO PUNCH-OUT no-coords] status=${r.status} success=${r.body.success} punchOut=${d.punchOut?.time} auditRows=${audits}`);
    expect(d.punchOut?.time).toBeFalsy();
    expect(audits).toBe(0);
  });
  test("[+] client auto-punch-out with geofence switched off (coords set) -> skipped", async () => {
    const e = A.people.empFenceOff;
    await punchIn(e, "2026-10-22T09:30:00");
    at("2026-10-22T09:40:00");
    await api(e.token).post("/attendance/auto-punch-out", OUT1KM);
    expect((await rec(e, "2026-10-22")).punchOut?.time).toBeFalsy();
  });
  test("[+] field executive: client auto-punch-out skipped", async () => {
    const e = A.people.field;
    await punchIn(e, "2026-10-22T09:30:00");
    at("2026-10-22T09:40:00");
    const r = await api(e.token).post("/attendance/auto-punch-out", OUT1KM);
    expect(r.body.skipped).toBe(true);
  });
});

describe("Rule 12: admin correction", () => {
  const adm = () => api(A.people.admin.token);
  test("[-] future date -> 400", async () => {
    at("2026-10-23T12:00:00");
    expect((await adm().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-10-24", punchInTime: "09:30", punchOutTime: "18:30" })).status).toBe(400);
  });
  test("[-] punch-in after punch-out (18:30 -> 09:30) -> 400", async () => {
    expect((await adm().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-10-16", punchInTime: "18:30", punchOutTime: "09:30" })).status).toBe(400);
  });
  test("[-] bad time format 9:5 / 25:00 / date 2026-02-30 -> 400", async () => {
    expect((await adm().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-10-16", punchInTime: "9:5" })).status).toBe(400);
    expect((await adm().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-10-16", punchInTime: "25:00" })).status).toBe(400);
    expect((await adm().patch("/attendance/admin-correct", { userId: A.people.emp1.userId, date: "2026-02-30", punchInTime: "09:00" })).status).toBe(400);
  });
  test("[+] status override Full Day with no times fills 09:30-18:30 from the shift", async () => {
    const r = await adm().patch("/attendance/admin-correct", { userId: A.people.empNoLunch.userId, date: "2026-10-16", statusOverride: "Full Day", note: "x" });
    expect(r.status).toBe(200);
    expect(r.body.data.punchIn.time).toBe("09:30:00");
    expect(r.body.data.punchOut.time).toBe("18:30:00");
    expect(r.body.data.status).toBe("Full Day");
  });
  test("[-] overnight correction 22:00 -> 06:00 for a night-shift employee is accepted (expect 200)", async () => {
    const r = await adm().patch("/attendance/admin-correct", { userId: A.people.night.userId, date: "2026-10-16", punchInTime: "22:00", punchOutTime: "06:00" });
    expect(r.status).toBe(200);
  });
  test("[-] 'Absent' override must keep the person in the Absent list", async () => {
    const r = await adm().patch("/attendance/admin-correct", { userId: A.people.emp2.userId, date: "2026-10-16", statusOverride: "Absent", note: "absent" });
    expect(r.status).toBe(200);
    const abs = await adm().get("/attendance/absent?date=2026-10-16");
    const ids = abs.body.data.map((u) => String(u._id));
    expect(ids).toContain(A.people.emp2.userId);
  });
});

describe("Rule 13 / 16 / 21: absent list, holidays, leave, weekly off, working days", () => {
  beforeAll(async () => {
    at("2026-10-27T10:00:00");
    await api(A.people.admin.token).post("/holidays", { name: "Rule13 Holiday", date: "2026-10-28", type: "Company" });
    const lt = await db.mongoose.connection.db.collection("leavetypes").insertOne({ name: "Casual", code: "CL", tenant_id: new db.mongoose.Types.ObjectId(A.tenantId) });
    await db.mongoose.connection.db.collection("leaverequests").insertOne({
      employeeId: new db.mongoose.Types.ObjectId(A.people.onLeave.userId), leaveTypeId: lt.insertedId,
      fromDate: new Date("2026-10-26T00:00:00+05:30"), toDate: new Date("2026-10-30T00:00:00+05:30"), totalDays: 5, reason: "trip", status: "approved",
    });
  });
  const absentIds = async (date) => (await api(A.people.admin.token).get(`/attendance/absent?date=${date}`)).body.data.map((u) => String(u._id));
  test("[-] PROPOSED: employee on approved leave is NOT in the Absent list", async () => {
    expect(await absentIds("2026-10-27")).not.toContain(A.people.onLeave.userId);
  });
  test("[-] PROPOSED: employee on weekly off (Wednesday) is NOT in the Absent list", async () => {
    expect(await absentIds("2026-10-28".replace("28", "21"))).not.toContain(A.people.weeklyOff.userId); // 2026-10-21 is a Wednesday
  });
  test("[-] PROPOSED: on a company holiday (2026-10-28) nobody is listed as Absent", async () => {
    expect((await absentIds("2026-10-28")).length).toBe(0);
  });
  test("[-] shift working days (Mon-Sat) used: on Sunday 2026-10-25 nobody on the General shift is Absent", async () => {
    expect(await absentIds("2026-10-25")).not.toContain(A.people.emp1.userId);
  });
  test("[-] suspected #21: punch-in on a company holiday is refused (or flagged)", async () => {
    const r = await punchIn(A.people.emp1, "2026-10-28T09:30:00");
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[-] suspected #21: punch-in while on approved leave is refused (or flagged)", async () => {
    const r = await punchIn(A.people.onLeave, "2026-10-27T09:30:00");
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  test("[+] Absent list is company-scoped (no Company B staff in A's list)", async () => {
    const ids = await absentIds("2026-10-27");
    expect(ids).not.toContain(B.people.emp1.userId);
  });
});

describe("Rule 14: attendance import", () => {
  const imp = (rows) => api(A.people.admin.token).post("/attendance/import", { rows });
  test("[-] 5,001 rows -> 400", async () => {
    at("2026-10-29T12:00:00");
    const rows = Array.from({ length: 5001 }, () => ({ employee: "x", date: "2026-10-01" }));
    expect((await imp(rows)).status).toBe(400);
  });
  test("[+] matching by code, email, mobile and exact name; ambiguous name and unknown rejected; future date rejected", async () => {
    const User = require("../models/user_model");
    const e2 = await User.findById(A.people.emp2.userId).lean();
    const ws = await User.findById(A.people.weeklyOff.userId).lean();
    const r = await imp([
      { employee: e2.employeeCode, date: "2026-09-01", punchIn: "09:30", punchOut: "18:30" },
      { employee: A.people.emp1.email.toUpperCase(), date: "2026-09-01", punchIn: "09:30", punchOut: "18:30" },
      { employee: `+91 ${ws.mobile}`, date: "2026-09-01", punchIn: "09:30", punchOut: "18:30" },
      { employee: "Face Alpha", date: "2026-09-01", punchIn: "09:30", punchOut: "18:30" },
      { employee: "Amit Shah Alpha", date: "2026-09-01", punchIn: "09:30", punchOut: "18:30" },
      { employee: "Nobody Here", date: "2026-09-01", punchIn: "09:30" },
      { employee: e2.employeeCode, date: "2026-12-01", punchIn: "09:30" },
      { employee: "Ravi Beta", date: "2026-09-01", punchIn: "09:30" }, // other company's employee
    ]);
    expect(r.status).toBe(200);
    const ok = r.body.data.results.map((x) => x.ok);
    expect(ok).toEqual([true, true, true, true, false, false, false, false]);
  });
});

describe("Field rules: Shift", () => {
  const adm = () => api(A.people.admin.token);
  const base = (n, extra = {}) => ({ name: n, startTime: "09:00", endTime: "18:00", ...extra });
  const cases = [
    ["name 1 char 'A' (min 2)", base("A"), 400],
    ["name spaces only", base("   "), 400],
    ["name missing", { startTime: "09:00", endTime: "18:00" }, 400],
    ["startTime 24:00", base("S-24", { startTime: "24:00" }), 400],
    ["startTime 9:00 (no leading zero)", base("S-9", { startTime: "9:00" }), 400],
    ["endTime missing", { name: "S-noend", startTime: "09:00" }, 400],
    ["late grace -1", base("S-g1", { lateGraceMinutes: -1 }), 400],
    ["late grace 121", base("S-g2", { lateGraceMinutes: 121 }), 400],
    ["late grace 1.5", base("S-g3", { lateGraceMinutes: 1.5 }), 400],
    ["late grace 'abc'", base("S-g4", { lateGraceMinutes: "abc" }), 400],
    ["OT grace 121", base("S-g5", { overtimeGraceMinutes: 121 }), 400],
    ["early-out grace 121", base("S-g6", { earlyOutGraceMinutes: 121 }), 400],
    ["allowed late 32", base("S-l1", { allowedLateCountPerMonth: 32 }), 400],
    ["allowed late -1", base("S-l2", { allowedLateCountPerMonth: -1 }), 400],
    ["lunch 481", base("S-lu", { lunch: { enabled: true, durationMinutes: 481 } }), 400],
    ["working days empty (at least 1)", base("S-wd0", { workingDays: [] }), 400],
    ["working days invalid 'Funday'", base("S-wd1", { workingDays: ["Funday"] }), 400],
    ["overnight 22:00-06:00 allowed", base("Overnight OK", { startTime: "22:00", endTime: "06:00" }), 201],
    ["boundaries 120 / 31 / 480 allowed", base("Bounds OK", { lateGraceMinutes: 120, overtimeGraceMinutes: 120, earlyOutGraceMinutes: 120, allowedLateCountPerMonth: 31, lunch: { enabled: true, durationMinutes: 480 } }), 201],
    ["duplicate name 'General' same company", base("General"), 400],
  ];
  test.each(cases)("create: %s", async (_label, body, expected) => {
    expect((await adm().post("/shifts", body)).status).toBe(expected);
  });
  test("[+] duplicate name 'General' in another company -> allowed (201)", async () => {
    expect((await api(B.people.admin.token).post("/shifts", base("General Copy"))).status).toBe(201);
    expect((await api(B.people.admin.token).post("/shifts", base("Overnight OK"))).status).toBe(201);
  });
  test("[i] case: 'general' (lower case) when 'General' exists — reported, not asserted", async () => {
    const r = await adm().post("/shifts", base("general"));
    console.log(`[SHIFT CASE] 'general' vs 'General' -> ${r.status}`);
    expect([201, 400]).toContain(r.status);
  });
  test("[-] edit: same rules on PATCH (late grace 121, name 'A', working days [] , duplicate name) -> 400 each", async () => {
    const id = String(A.shifts.punchLunch);
    expect((await adm().patch(`/shifts/${id}`, { lateGraceMinutes: 121 })).status).toBe(400);
    expect((await adm().patch(`/shifts/${id}`, { name: "General" })).status).toBe(400);
    expect((await adm().patch(`/shifts/${id}`, { name: "A" })).status).toBe(400);
    expect((await adm().patch(`/shifts/${id}`, { workingDays: [] })).status).toBe(400);
    expect((await adm().patch(`/shifts/${id}`, { startTime: "7pm" })).status).toBe(400);
  });
  test("[-] suspected #24: deleting a shift that still has staff assigned is blocked", async () => {
    const r = await adm().post("/shifts", base("ToDelete"));
    await adm().post(`/shifts/${r.body.data._id}/assign`, { userIds: [A.people.otherBranch.userId] });
    const d = await adm().del(`/shifts/${r.body.data._id}`);
    expect(d.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Field rules: Holiday", () => {
  const adm = () => api(A.people.admin.token);
  test.each([
    ["name missing", { date: "2026-11-10" }, 400],
    ["name spaces only", { name: "   ", date: "2026-11-10" }, 400],
    ["date missing", { name: "No date" }, 400],
    ["date 2026-02-30", { name: "Bad date", date: "2026-02-30" }, 400],
    ["date 'abc'", { name: "Bad date 2", date: "abc" }, 400],
    ["end date before date", { name: "Backwards", date: "2026-11-10", endDate: "2026-11-09" }, 400],
    ["invalid type", { name: "Bad type", date: "2026-11-11", type: "Party" }, 400],
    ["valid single day", { name: "Diwali", date: "2026-11-08", type: "Festival" }, 201],
    ["valid 3-day range", { name: "Diwali Break", date: "2026-11-09", endDate: "2026-11-11" }, 201],
    ["duplicate name+date same company", { name: "Diwali", date: "2026-11-08" }, 400],
    ["XSS text stored as plain text", { name: "<script>alert(1)</script>", date: "2026-11-12", description: "<img src=x onerror=alert(1)>" }, 201],
  ])("create: %s", async (_l, body, expected) => {
    at("2026-10-29T12:00:00");
    expect((await adm().post("/holidays", body)).status).toBe(expected);
  });
  test("[+] same name+date in another company -> 201", async () => {
    expect((await api(B.people.admin.token).post("/holidays", { name: "Diwali", date: "2026-11-08" })).status).toBe(201);
  });
  test("[-] edit: end date before start -> 400; bad date -> 400", async () => {
    const h = await adm().post("/holidays", { name: "Edit me", date: "2026-11-20" });
    expect((await adm().put(`/holidays/${h.body.data._id}`, { endDate: "2026-11-19" })).status).toBe(400);
    expect((await adm().put(`/holidays/${h.body.data._id}`, { date: "2026-13-01" })).status).toBe(400);
  });
});

describe("Negative: double-click / concurrency", () => {
  test("[-] two simultaneous punch-ins -> exactly one 201, the other 4xx (never 500)", async () => {
    at("2026-10-30T09:30:00");
    const e = A.people.supervisor;
    const [r1, r2] = await Promise.all([1, 2].map(() => api(e.token).post("/attendance/punch-in", H.punchForm({ ...IN }))));
    const codes = [r1.status, r2.status].sort();
    console.log(`[DOUBLE PUNCH-IN] ${codes}`);
    expect(codes.filter((c) => c === 201).length).toBe(1);
    expect(codes.some((c) => c >= 500)).toBe(false);
  });
  test("[-] two simultaneous lunch-ins -> one 200, the other 400", async () => {
    at("2026-10-30T13:00:00");
    const e = A.people.supervisor;
    const rs = await Promise.all([1, 2].map(() => api(e.token).post("/attendance/lunch-in", IN)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});
