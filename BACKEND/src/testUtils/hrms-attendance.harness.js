// HRMS Part B (Attendance) test harness — shared by the jest suites
// (src/hrms/__tests__/hrms-attendance.*.test.js) and the UI stack
// (startHrmsAttendanceTestStack.js).
//
// SAFETY
//   * In-memory MongoDB only (mongodb-memory-server). MONGO_URI is overwritten
//     before any app module loads; we refuse to continue unless the connection
//     host is 127.0.0.1/localhost. The real .env is never read.
//   * Backend port 5207 only (frontend 5307). Nothing here touches :5001/:5183.
//   * External services are stubbed IN-PROCESS (no network):
//       - reverse geocoding (Google/Mappls/Ola/Nominatim) -> fixed string
//       - Cloudinary upload -> fixed URL (no disk writes into the repo)
//       - Face service (Python BOTLens) -> axios interceptor for a fake host
//     The app's own logic (geofence, selfie match, kiosk, thresholds) is NOT stubbed.
//
// FACE STUB PROTOCOL — the uploaded image bytes decide what the "face service" sees:
//   "FACES:a,b"  -> two faces, labels a and b      "NOFACE" -> no face
//   "SMALL:a"    -> one face, 30px wide             "BAD"    -> unreadable image
//   "FACE:a"     -> one face, label a
//   anything else (a real JPEG from the browser's fake camera) -> label STUB_DEFAULT_FACE
// Same label = identical embedding (cosine 1.0); different labels are random
// 128-d vectors (cosine ~0), far below the 0.42 match threshold.

const path = require("path");
const http = require("http");

const PORT = 5207;
const FE_ORIGIN = "http://127.0.0.1:5307";
const FACE_HOST = "http://face-stub.hrms-attendance.invalid";
const PASSWORD = "Test@1234";

let stubsInstalled = false;
const stubLog = { geocode: 0, upload: 0, faceEmbed: 0 };

function embedFor(label) {
  // Deterministic pseudo-random vector from the label (mulberry32 seeded by a string hash).
  let h = 2166136261;
  for (const c of String(label)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  return Array.from({ length: 128 }, rnd);
}

function fakeFaceResult(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("utf8", 0, Math.min(buf.length, 200)) : String(buf);
  const face = (label, w = 200) => ({ box: [10, 10, w, w], score: 0.99, pose: { yaw: "front", pitch: "level" }, embedding: embedFor(label) });
  if (s.startsWith("BAD")) return { error: "unreadable", width: 0, height: 0, faces: [] };
  if (s.startsWith("NOFACE")) return { width: 640, height: 480, faces: [] };
  if (s.startsWith("FACES:")) return { width: 640, height: 480, faces: s.slice(6).trim().split(",").map((l) => face(l.trim())) };
  if (s.startsWith("SMALL:")) return { width: 640, height: 480, faces: [face(s.slice(6).trim(), 30)] };
  if (s.startsWith("FACE:")) return { width: 640, height: 480, faces: [face(s.slice(5).trim())] };
  return { width: 640, height: 480, faces: [face(process.env.STUB_DEFAULT_FACE || "kiosk-person")] };
}

// Must run BEFORE any controller is required (they destructure these helpers at load).
function installStubs({ faceServiceDown = false } = {}) {
  if (stubsInstalled) return;
  stubsInstalled = true;
  process.env.FACE_SERVICE_URL = FACE_HOST;
  process.env.FACE_SERVICE_DOWN = faceServiceDown ? "1" : "";
  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "GOOGLE_MAPS_API_KEY",
    "MAPPLS_API_KEY", "OLA_MAPS_API_KEY", "FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT_PATH", "GOOGLE_APPLICATION_CREDENTIALS"]) delete process.env[k];

  const geocode = require("../hrms/utils/geocode");
  geocode.reverseGeocode = async (lat, lng) => {
    stubLog.geocode++;
    if (!lat || !lng) return null;
    return `Stub address ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
  };
  const upload = require("../hrms/utils/cloudinary_config");
  upload.uploadToCloudinary = async (file) => {
    stubLog.upload++;
    return `https://stub.cdn.invalid/hrms-attendance/${Date.now()}-${(file && file.originalname) || "upload.jpg"}`;
  };

  const axios = require("axios");
  const realPost = axios.post.bind(axios);
  const realGet = axios.get.bind(axios);
  const down = () => { const e = new Error("connect ECONNREFUSED (stub)"); e.code = "ECONNREFUSED"; return Promise.reject(e); };
  axios.post = (url, body, opts) => {
    if (String(url).startsWith(FACE_HOST)) {
      if (process.env.FACE_SERVICE_DOWN === "1") return down();
      stubLog.faceEmbed++;
      const images = (body && body.images) || [];
      return Promise.resolve({ data: { results: images.map((b64) => fakeFaceResult(Buffer.from(b64, "base64"))) } });
    }
    return realPost(url, body, opts);
  };
  axios.get = (url, opts) => {
    if (String(url).startsWith(FACE_HOST)) {
      if (process.env.FACE_SERVICE_DOWN === "1") return down();
      return Promise.resolve({ data: { status: "ok" } });
    }
    // Block any accidental external call from the app during tests.
    if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(String(url))) return Promise.reject(new Error(`external call blocked in test: ${url}`));
    return realGet(url, opts);
  };
}

async function startDb() {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongoose = require("mongoose");
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGO_URI = uri;
  process.env.JWT_SECRET = "hrms-attendance-test-secret";
  delete process.env.JOB_SECRET;
  if (!uri.startsWith("mongodb://127.0.0.1")) throw new Error(`GUARD FAILURE: expected in-memory URI on 127.0.0.1, got ${uri}`);
  await mongoose.connect(uri);
  if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) {
    throw new Error(`GUARD FAILURE: refusing non-local DB host ${mongoose.connection.host}`);
  }
  return { mongod, uri, mongoose };
}

const FULL = { "View(Global)": true, Create: true, Edit: true, Delete: true };
const VIEW = { "View(Global)": true };

// HQ branch centre (Ahmedabad). 0.001 deg latitude ~ 111 m.
const HQ = { lat: 23.0225, lng: 72.5714 };
const offsetLat = (m) => HQ.lat + m / 111195;

async function seedCompany(db, jwt, ObjectId, { key, label, ownerEmail, features = [], planOff = false, hiddenFeatures = [] }) {
  const tenantId = new ObjectId();
  let planId = null;
  if (planOff) {
    planId = new ObjectId();
    await db.collection("saasplans").insertOne({ _id: planId, name: `NoHRMS-${key}`, price: 0, module_access: { hrms: false }, createdAt: new Date(), updatedAt: new Date() });
  }
  await db.collection("tenants").insertOne({
    _id: tenantId, company_name: label, name: label, status: "active", enabled_features: features,
    hidden_hrms_features: hiddenFeatures, ...(planId ? { plan_id: planId } : {}), createdAt: new Date(), updatedAt: new Date(),
  });
  const role = async (roleKey, roleLabel, permissions) => {
    const _id = new ObjectId();
    await db.collection("hrmsroles").insertOne({ _id, role: roleKey, label: roleLabel, permissions, tenant_id: tenantId, attendanceRequired: true, createdAt: new Date(), updatedAt: new Date() });
    return _id;
  };
  const roles = {
    admin: await role("admin", "Admin", ["*"]),
    employee: await role("employee", "Employee", []),
    attendance: await role("attendance_officer", "Attendance Officer", ["view_attendance"]),
    shift: await role("shift_manager", "Shift Manager", ["manage_shifts"]),
    field: await role("field_executive", "Field Executive", []),
  };

  const branch = async (name, extra) => {
    const _id = new ObjectId();
    await db.collection("hrmsbranches").insertOne({ _id, name, tenant_id: tenantId, status: "Active", supervisorIds: [], radius: 500, radiusUnit: "m", geoFenceEnabled: false, createdAt: new Date(), updatedAt: new Date(), ...extra });
    return _id;
  };
  const branches = {
    hq: await branch(`${label} HQ`, { latitude: HQ.lat, longitude: HQ.lng, radius: 200, geoFenceEnabled: true }),
    noCoords: await branch(`${label} NoCoords`, { geoFenceEnabled: true }),
    fenceOff: await branch(`${label} FenceOff`, { latitude: HQ.lat, longitude: HQ.lng, radius: 200, geoFenceEnabled: false }),
  };

  const shift = async (name, extra) => {
    const _id = new ObjectId();
    await db.collection("shifts").insertOne({
      _id, name, tenant_id: tenantId, startTime: "09:30", endTime: "18:30", lateGraceMinutes: 15, allowedLateCountPerMonth: 3,
      workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], overtimeGraceMinutes: 30, earlyOutGraceMinutes: 15, overtimeRatePerHour: 100,
      lunch: { enabled: true, mode: "flexible_duration", startTime: "13:00", endTime: "14:00", durationMinutes: 60, deduction: "auto" },
      reminders: { enabled: false }, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    return _id;
  };
  const shifts = {
    general: await shift("General"),
    punchLunch: await shift("PunchLunch", { lunch: { enabled: true, mode: "flexible_duration", durationMinutes: 60, deduction: "punch" } }),
    noLunch: await shift("NoLunch", { lunch: { enabled: false } }),
    night: await shift("Night", { startTime: "22:00", endTime: "06:00", lunch: { enabled: false } }),
  };

  const people = {};
  let n = 0;
  const person = async (pkey, { name, roleKey = "employee", admin = false, crmPerms = {}, branchId = branches.hq, shiftId = shifts.general, email, mobile, extra = {} }) => {
    n++;
    const userId = new ObjectId();
    const staffId = new ObjectId();
    const mail = email || `${pkey.toLowerCase()}.${key}@hrms-attendance.test`;
    await db.collection("users").insertOne({
      _id: userId, name: name || `${pkey} ${label}`, email: mail, password: "x", role: roles[roleKey], tenant_id: tenantId,
      isActive: true, attendanceRequired: true, mobile: mobile || `98${String(Math.abs(hash(key)) % 100).padStart(2, "0")}${String(n).padStart(6, "0")}`,
      hrmsBranchId: branchId, shiftId, employeeCode: `${key.toUpperCase()}-${String(n).padStart(3, "0")}`, salaryAmount: 30000,
      weeklyHolidays: [], createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    await db.collection("staffs").insertOne({
      _id: staffId, firstname: pkey, lastname: label, email: mail, password: "x", active: true, admin, tenant_id: tenantId,
      hrms_user_id: userId, permissions: crmPerms, createdAt: new Date(), updatedAt: new Date(),
    });
    const token = jwt.sign({ id: String(staffId), role: "staff" }, process.env.JWT_SECRET);
    people[pkey] = { key: pkey, userId: String(userId), staffId: String(staffId), email: mail, token };
    return people[pkey];
  };

  await person("admin", { name: `Admin ${label}`, roleKey: "admin", admin: true, email: ownerEmail || `admin.${key}@hrms-attendance.test` });
  // Only the Attendance permission, on BOTH systems (Setup > Roles screen perms + HRMS role).
  await person("attOfficer", { roleKey: "attendance", crmPerms: { "HRMS Attendance": VIEW } });
  // Screen permission only (Setup > Roles) — HRMS role has nothing: shows the two systems are not synced.
  await person("attScreenOnly", { roleKey: "employee", crmPerms: { "HRMS Attendance": VIEW } });
  await person("shiftMgr", { roleKey: "shift", crmPerms: { "HRMS Shift Management": VIEW } });
  await person("emp1", { name: `Ravi ${label}` });
  await person("emp2", { name: `Sita ${label}` });
  await person("empPunchLunch", { shiftId: shifts.punchLunch });
  await person("empNoLunch", { shiftId: shifts.noLunch });
  await person("empNoCoords", { branchId: branches.noCoords });
  await person("empFenceOff", { branchId: branches.fenceOff });
  await person("field", { roleKey: "field", name: `Field ${label}` });
  await person("night", { shiftId: shifts.night, branchId: branches.fenceOff });
  await person("supervisor", { name: `Supervisor ${label}`, branchId: branches.fenceOff });
  await person("otherBranch", { branchId: branches.fenceOff });
  await person("faceEmp", { name: `Face ${label}` });
  await person("dupName1", { name: `Amit Shah ${label}` });
  await person("dupName2", { name: `Amit Shah ${label}` });
  await person("weeklyOff", { extra: { weeklyHolidays: ["Wednesday"] } });
  await person("onLeave", {});
  await person("noAccess", { crmPerms: {} });
  await db.collection("hrmsbranches").updateOne({ _id: branches.hq }, { $set: { supervisorIds: [new ObjectId(people.supervisor.userId)] } });

  return { key, label, tenantId: String(tenantId), roles, branches, shifts, people, planOff };
}

function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

async function seedAll() {
  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const db = mongoose.connection.db;
  const { ObjectId } = mongoose.Types;
  // Ensure model indexes (unique userId+date etc.) exist before tests run.
  for (const m of ["attendance_model", "shift_model", "holiday_model", "hrms_branch_model", "user_model", "role_model", "face_profile_model", "geofence_audit_model", "attendance_event_model", "leave_request_model", "leave_type_model", "employee_route_model"]) {
    try { await require(`../hrms/models/${m}`).init(); } catch { /* model may not exist */ }
  }
  require("../models/Staff"); require("../models/Tenant");
  try { require("../models/QuotationType"); } catch { /* populated by branches */ }
  const T = {
    A: await seedCompany(db, jwt, ObjectId, { key: "alpha", label: "Alpha", features: ["face_attendance"] }),
    B: await seedCompany(db, jwt, ObjectId, { key: "beta", label: "Beta" }),
    R: await seedCompany(db, jwt, ObjectId, { key: "rudra", label: "Rudraverse", ownerEmail: "info@trinetratechnoworld.com", features: ["face_attendance"] }),
    P: await seedCompany(db, jwt, ObjectId, { key: "planoff", label: "PlanOff", planOff: true }),
  };
  return T;
}

// Express app: plan gate + /api/hrms (+ main CRM shell routes for the UI) + Socket.IO.
function buildApp({ withShell = false, logRequests = false } = {}) {
  const express = require("express");
  const cors = require("cors");
  const cookieParser = require("cookie-parser");
  const jwt = require("jsonwebtoken");
  const app = express();
  app.use(cors({ origin: [FE_ORIGIN, "http://localhost:5307"], credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  if (logRequests) app.use((req, res, next) => { if (req.path.startsWith("/api/")) console.log(`[REQ] ${req.method} host=${req.headers.host} ${req.originalUrl}`); next(); });
  app.use("/api", require("../middleware/planModules").planModuleGate);

  const Staff = require("../models/Staff");
  app.post("/api/test-login", async (req, res) => {
    const staff = await Staff.findOne({ email: String(req.body?.email || "").trim().toLowerCase() }).lean();
    if (!staff) return res.status(401).json({ message: "Unknown test user" });
    const token = jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET);
    res.json({ token, user: { ...staff, password: undefined } });
  });
  app.get("/api/health", (req, res) => res.json({ status: "ok", inMemory: true, uri: process.env.MONGO_URI, port: PORT }));

  const routes = [["/api/hrms", "../hrms/routes/index"]];
  if (withShell) {
    routes.unshift(
      ["/api/auth", "../routes/auth_routes"], ["/api/staff", "../routes/staff_routes"], ["/api/roles", "../routes/role_routes"],
      ["/api/settings", "../routes/setting_routes"], ["/api/mainsidebar", "../routes/mainsidebar_routes"], ["/api/modules", "../routes/module_routes"],
      ["/api/todos", "../routes/todo_routes"], ["/api/reminders", "../routes/reminder_routes"], ["/api/quotation-types", "../routes/quotation_type_routes"],
      ["/api/chat", "../routes/chat_routes"], ["/api/currencies", "../routes/currency_routes"], ["/api/custom-fields", "../routes/custom_field_routes"],
    );
  }
  for (const [mount, mod] of routes) {
    try { app.use(mount, require(mod)); } catch (err) { console.log(`[ROUTE SKIPPED] ${mount}: ${err.message}`); }
  }
  // Same contract as index.js's global error handler (4xx kept, everything else 500).
  app.use((err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: "Global Server Error: " + err.message });
  });

  const server = http.createServer(app);
  // Socket.IO exactly as production wires it: index.js creates the io, sets
  // app.set("io") and registers ONLY a `join` handler (copied verbatim below,
  // index.js:712-716). The HRMS socket_handler (join-room / global-tracking /
  // location relay) is also attached so its own behaviour can be tested.
  const initSocket = require("../hrms/utils/socket_handler");
  const io = initSocket(server);
  io.on("connection", (socket) => {
    socket.on("join", (userId) => { socket.join(userId); }); // == index.js:713-715
  });
  app.set("io", io);
  return { app, server, io };
}

async function listen(server, port = PORT) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${port}`;
}

function makeClient(base) {
  return (token) => {
    const call = async (method, p, body, extraHeaders = {}) => {
      const headers = { ...extraHeaders };
      if (token) headers.Authorization = token.startsWith("RAW:") ? token.slice(4) : `Bearer ${token}`;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
      const t0 = Date.now();
      const res = await fetch(base + p, { method, headers, body: payload });
      let json = null;
      const text = await res.text();
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, ms: Date.now() - t0 };
    };
    return {
      get: (p, h) => call("GET", p, undefined, h), post: (p, b, h) => call("POST", p, b, h), put: (p, b) => call("PUT", p, b),
      patch: (p, b) => call("PATCH", p, b), del: (p) => call("DELETE", p),
    };
  };
}

// Build a multipart body with optional selfie bytes.
function punchForm(fields = {}, selfie) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
  if (selfie !== undefined) fd.append("selfie", new Blob([Buffer.from(selfie)], { type: "image/jpeg" }), "selfie.jpg");
  return fd;
}

// Set the fake clock to an IST wall time, e.g. ist("2026-10-14T09:40:00").
const ist = (s) => new Date(`${s}+05:30`);

module.exports = {
  PORT, FE_ORIGIN, FACE_HOST, PASSWORD, HQ, offsetLat, FULL, VIEW, stubLog,
  installStubs, startDb, seedAll, buildApp, listen, makeClient, punchForm, ist, embedFor, fakeFaceResult,
};
