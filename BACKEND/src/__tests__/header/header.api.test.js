// HEADER (top navbar) — backend side (test-prompts/02-header.md, phases 4, 5, 6, 9, 10, 11).
// Covers only what the header talks to: POST /api/auth/logout (+ is the session really ended),
// the estimate-request forms list used by Share > Public quote forms, and the notification
// sources that reach the bell over socket.io (chat newMessage + the "join" room handler).
// In-memory MongoDB only (startHeaderTestStack.js, random port). Each test states the CORRECT
// behaviour (PROPOSED rules treated as real) — a failure = a bug.
jest.setTimeout(180000);

const path = require("path");
const { boot, PASSWORD } = require("../../testUtils/startHeaderTestStack");
// socket.io-client lives in the frontend's node_modules (not a backend dependency; not added).
const { io: ioClient } = require(path.resolve(__dirname, "../../../../FRONTEND/node_modules/socket.io-client"));

let S, T, base;
const sessions = {};

const call = async (method, p, { token, body, headers = {} } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers };
};
const login = async (email) => {
  const r = await call("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  if (!r.body?.token) throw new Error(`login failed ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const sess = (tenant, kind) => sessions[`${tenant}.${kind}`];
const jwt = require("jsonwebtoken");
const tokenFor = (staff) => jwt.sign({ id: String(staff._id), role: "staff" }, process.env.JWT_SECRET, { expiresIn: "10h" });

const connectSocket = (room) => new Promise((resolve, reject) => {
  const s = ioClient(base, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.on("connect", () => { if (room) s.emit("join", room); setTimeout(() => resolve(s), 150); });
  s.on("connect_error", reject);
});
const waitFor = (sock, event, ms = 2500) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  sock.once(event, (p) => { clearTimeout(t); resolve(p); });
});

beforeAll(async () => {
  S = await boot({ port: 0, log: false });
  T = S.T;
  base = S.baseUrl;
  for (const key of ["Alpha", "Beta", "NoPlan"]) {
    for (const kind of ["admin", "full", "viewGlobal", "viewOwn", "noAccess", "staffAdmin"]) {
      sessions[`${key}.${kind}`] = await login(T[key].users[kind].email);
    }
  }
  // Rudraverse staff get e-mail 2FA at login (pilot tenant) — sign their token directly.
  sessions["Rudraverse.admin"] = await login("info@trinetratechnoworld.com");
  sessions["Rudraverse.full"] = { token: tokenFor(T.Rudraverse.users.full) };
  sessions.super = await login("super@header-test.local");
});
afterAll(async () => { if (S) await S.stop(); });

// ───────────────────────────── POST /api/auth/logout ─────────────────────────────
describe("[API] POST /api/auth/logout", () => {
  test("with a valid token → 200 'Logged out successfully' and clears the token cookie", async () => {
    const r = await call("POST", "/api/auth/logout", { token: sess("Alpha", "viewOwn").token });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe("Logged out successfully");
    expect(r.headers.get("set-cookie") || "").toMatch(/token=;/);
  });
  test("no token → still 200 (idempotent), never 500", async () => {
    const r = await call("POST", "/api/auth/logout");
    expect(r.status).toBe(200);
  });
  test("malformed JSON body → 4xx, never 500", async () => {
    const r = await call("POST", "/api/auth/logout", { body: "{bad json" });
    expect(r.status).toBeLessThan(500);
  });
});

describe("[Security] logout really ends the session", () => {
  test("old ACCESS token is rejected by the API after logout (expected 401)", async () => {
    const s = await login(T.Beta.users.viewOwn.email);
    expect((await call("GET", "/api/auth/me", { token: s.token })).status).toBe(200);
    await call("POST", "/api/auth/logout", { token: s.token });
    const after = await call("GET", "/api/auth/me", { token: s.token });
    expect(after.status).toBe(401);
  });
  test("old REFRESH token cannot mint a new access token after logout (expected 401)", async () => {
    const s = await login(T.Beta.users.full.email);
    await call("POST", "/api/auth/logout", { token: s.token });
    const r = await call("POST", "/api/auth/refresh", { body: { refreshToken: s.refreshToken } });
    expect(r.status).toBe(401);
  });
  test("token cookie set at login is cleared by logout (cookie path works)", async () => {
    const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: T.Beta.users.admin.email, password: PASSWORD }) });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toMatch(/^token=/);
    const me = await call("GET", "/api/auth/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const out = await call("POST", "/api/auth/logout", { headers: { Cookie: cookie } });
    expect(out.headers.get("set-cookie") || "").toMatch(/token=;/);
  });
});

// ───────────────────── GET /api/estimate-request-forms (Share menu) ─────────────────────
describe("[API] GET /api/estimate-request-forms", () => {
  test("no token → 401", async () => expect((await call("GET", "/api/estimate-request-forms")).status).toBe(401));
  test("bad token → 401", async () => expect((await call("GET", "/api/estimate-request-forms", { token: "abc.def.ghi" })).status).toBe(401));
  test("token signed with the wrong secret → 401", async () => {
    const forged = jwt.sign({ id: String(T.Alpha.users.admin._id), role: "staff" }, "wrong-secret");
    expect((await call("GET", "/api/estimate-request-forms", { token: forged })).status).toBe(401);
  });
  test("admin Alpha → 200, array, own forms present", async () => {
    const r = await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "admin").token });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((f) => f.name)).toEqual(expect.arrayContaining(["Alpha Traders Quote Form"]));
  });
  test("[Security] admin Alpha never sees Beta's forms", async () => {
    const r = await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "admin").token });
    expect(r.body.some((f) => /Beta Works|Rudraverse/.test(f.name))).toBe(false);
  });
  test("[Security] a form with no tenant_id (legacy) is NOT shown to every company", async () => {
    const a = await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "admin").token });
    const b = await call("GET", "/api/estimate-request-forms", { token: sess("Beta", "admin").token });
    const leak = [a, b].filter((r) => r.body.some((f) => f.name === "Legacy untenanted form")).length;
    expect(leak).toBe(0);
  });
  test("[Role] staff with View Estimate Request → 200", async () => {
    expect((await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "viewGlobal").token })).status).toBe(200);
  });
  test("[Role] staff with NO Estimate Request permission → 403", async () => {
    expect((await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "noAccess").token })).status).toBe(403);
  });
  test("[Plan] plan with estimate_request OFF → 403 MODULE_DISABLED", async () => {
    const r = await call("GET", "/api/estimate-request-forms", { token: sess("NoPlan", "admin").token });
    expect(r.status).toBe(403);
  });
  test("[API] wrong-company form id → 404", async () => {
    const r = await call("GET", `/api/estimate-request-forms/${T.Beta.forms[0]._id}`, { token: sess("Alpha", "admin").token });
    expect(r.status).toBe(404);
  });
  test("[Negative] invalid id 'abc' → 400/404, never 500", async () => {
    const r = await call("GET", "/api/estimate-request-forms/abc", { token: sess("Alpha", "admin").token });
    expect([400, 404]).toContain(r.status);
  });
  test("[Security] NoSQL injection in id ({\"$ne\":null}) → 400/404 and no data leak", async () => {
    const r = await call("GET", `/api/estimate-request-forms/${encodeURIComponent('{"$ne":null}')}`, { token: sess("Alpha", "admin").token });
    expect([400, 404]).toContain(r.status);
  });
  test("[Security] public form link works without login (expected 200)", async () => {
    const r = await call("GET", `/api/estimate-request-forms/public/${T.Alpha.forms[0]._id}`);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Alpha Traders Quote Form");
  });
  test("[Security] XSS form name is returned as plain data (rendering must escape it)", async () => {
    const r = await call("GET", "/api/estimate-request-forms", { token: sess("Alpha", "admin").token });
    expect(r.body.some((f) => f.name.includes("<img src=x onerror=alert(1)>"))).toBe(true);
  });
  test("[Rudraverse] owner sees only Rudraverse forms (no special behaviour)", async () => {
    const r = await call("GET", "/api/estimate-request-forms", { token: sess("Rudraverse", "admin").token });
    expect(r.status).toBe(200);
    expect(r.body.filter((f) => f.tenant_id).every((f) => String(f.tenant_id) === String(T.Rudraverse.tenantId))).toBe(true);
  });
});

// ──────────────────── Notification sources: chat → socket "newMessage" ────────────────────
describe("[Integration] chat message reaches the receiver's bell live (socket)", () => {
  test("Alpha full → Alpha viewGlobal: receiver socket gets newMessage with sender + text", async () => {
    const receiver = T.Alpha.users.viewGlobal;
    const sock = await connectSocket(String(receiver._id));
    const got = waitFor(sock, "newMessage");
    const r = await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(receiver._id), message: "hello from A" } });
    const msg = await got;
    sock.close();
    expect(r.status).toBe(201);
    expect(msg).toMatchObject({ message: "hello from A", sender: { firstname: "Full" } });
  });
  test("XSS chat text is delivered unchanged as data (header must render it as text)", async () => {
    const receiver = T.Alpha.users.viewOwn;
    const sock = await connectSocket(String(receiver._id));
    const got = waitFor(sock, "newMessage");
    await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(receiver._id), message: "<img src=x onerror=alert(1)>" } });
    const msg = await got;
    sock.close();
    expect(msg.message).toBe("<img src=x onerror=alert(1)>");
  });
  test("[Security] chat to a staff member of ANOTHER company is refused (expected 403/404)", async () => {
    const r = await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(T.Beta.users.admin._id), message: "cross-tenant ping" } });
    expect([403, 404]).toContain(r.status);
  });
  test("[Security] another company's staff does NOT get a notification from Alpha", async () => {
    const victim = T.Beta.users.viewGlobal;
    const sock = await connectSocket(String(victim._id));
    const got = waitFor(sock, "newMessage", 1500);
    await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(victim._id), message: "spam into Beta" } });
    const msg = await got;
    sock.close();
    expect(msg).toBeNull();
  });
  test("[Role] staff with NO Chat permission cannot send chat (expected 403)", async () => {
    const r = await call("POST", "/api/chat/send", { token: sess("Alpha", "noAccess").token, body: { receiverId: String(T.Alpha.users.admin._id), message: "no perm" } });
    expect(r.status).toBe(403);
  });
  test("[Plan] chat OFF in plan → POST /api/chat/send 403", async () => {
    const r = await call("POST", "/api/chat/send", { token: sess("NoPlan", "full").token, body: { receiverId: String(T.NoPlan.users.admin._id), message: "plan off" } });
    expect(r.status).toBe(403);
  });
  test("[Negative] empty message → 400, nothing emitted", async () => {
    const r = await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(T.Alpha.users.admin._id), message: "" } });
    expect(r.status).toBe(400);
  });
  test("[Negative] NoSQL injection as receiverId → 4xx, never 500", async () => {
    const r = await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: { $ne: null }, message: "inj" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
  test("[API] chat send with no token → 401, bad token → 401", async () => {
    expect((await call("POST", "/api/chat/send", { body: { receiverId: "x", message: "y" } })).status).toBe(401);
    expect((await call("POST", "/api/chat/send", { token: "bad", body: { receiverId: "x", message: "y" } })).status).toBe(401);
  });
});

describe("[Security] socket.io rooms (index.js 'join' handler)", () => {
  test("an UNAUTHENTICATED socket cannot join another user's room and read their notifications", async () => {
    const victim = T.Alpha.users.admin;
    const spy = await connectSocket(String(victim._id)); // no token at all
    const got = waitFor(spy, "newMessage", 2000);
    await call("POST", "/api/chat/send", { token: sess("Alpha", "full").token, body: { receiverId: String(victim._id), message: "private for admin" } });
    const leaked = await got;
    spy.close();
    expect(leaked).toBeNull();
  });
  test("an unauthenticated socket cannot join a whole company's tenant room", async () => {
    const spy = await connectSocket(`tenant-${T.Beta.tenantId}`);
    const got = waitFor(spy, "callingAgentUpdate", 1500);
    S.io.to(`tenant-${T.Beta.tenantId}`).emit("callingAgentUpdate", { secret: "beta-call" });
    const leaked = await got;
    spy.close();
    expect(leaked).toBeNull();
  });
});

// ───────────────────────────── Role label / admin flag ─────────────────────────────
describe("[Role] /api/auth/me data the profile menu shows", () => {
  test("admin → admin:true, no role, permissions null", async () => {
    const r = await call("GET", "/api/auth/me", { token: sess("Alpha", "admin").token });
    expect(r.body.user.admin).toBe(true);
    expect(r.body.user.role).toBeFalsy();
  });
  test("staff with admin flag + role named 'Admin' → backend says admin:true (frontend then treats as staff — see UI test)", async () => {
    const r = await call("GET", "/api/auth/me", { token: sess("Alpha", "staffAdmin").token });
    expect(r.body.user.admin).toBe(true);
    expect(r.body.user.role.name).toBe("Admin");
    expect(r.body.permissions).toBeNull();
  });
  test("super admin → is_superadmin true", async () => {
    const r = await call("GET", "/api/auth/me", { token: sessions.super.token });
    expect(r.body.user.is_superadmin).toBe(true);
  });
});

// ───────────────────────────── Performance (local only) ─────────────────────────────
describe("[Performance] local timings", () => {
  test("20 users logging out at once — all 200, under 3 s total", async () => {
    const tokens = Array.from({ length: 20 }, () => sess("Alpha", "full").token);
    const t0 = Date.now();
    const res = await Promise.all(tokens.map((t) => call("POST", "/api/auth/logout", { token: t })));
    const ms = Date.now() - t0;
    console.log(`[PERF] 20 parallel logouts: ${ms} ms`);
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(ms).toBeLessThan(3000);
  });
  test("forms list with 300 forms, 20 users at once — all 200, p95 under 2 s", async () => {
    const EstimateRequestForm = require("../../models/EstimateRequestForm");
    await EstimateRequestForm.insertMany(Array.from({ length: 300 }, (_, i) => ({ name: `Perf form ${i}`, tenant_id: T.Beta.tenantId, fields: [{ type: "text", label: "Name" }] })));
    const times = await Promise.all(Array.from({ length: 20 }, async () => {
      const t0 = Date.now();
      const r = await call("GET", "/api/estimate-request-forms", { token: sess("Beta", "admin").token });
      return { ms: Date.now() - t0, status: r.status, n: r.body.length };
    }));
    const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95) - 1];
    console.log(`[PERF] forms list x20 parallel: min ${sorted[0]} ms, p95 ${p95} ms, max ${sorted.at(-1)} ms, rows ${times[0].n}`);
    expect(times.every((t) => t.status === 200)).toBe(true);
    expect(p95).toBeLessThan(2000);
  });
  test("100 socket notifications in a burst are all delivered", async () => {
    const room = String(T.Alpha.users.full._id);
    const sock = await connectSocket(room);
    let n = 0;
    sock.on("goalUpdate", () => { n++; });
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) S.io.to(room).emit("goalUpdate", { event: "achieved", subject: `G${i}` });
    await new Promise((r) => setTimeout(r, 1500));
    sock.close();
    console.log(`[PERF] 100 socket events delivered: ${n} in <= ${Date.now() - t0} ms`);
    expect(n).toBe(100);
  });
});
