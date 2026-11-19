// Goals module — INTEGRATION tests (permissions, plan gate, tenant isolation), 05-goals.md section 4.
// In-memory MongoDB only. Each test states the CORRECT behaviour; a failure = a bug.
jest.setTimeout(120000);

const { boot, stop, validBody } = require("../../testUtils/goalsFixtures");

let ctx, Goal, A, B, C;

beforeAll(async () => {
  ctx = await boot();
  ({ Goal, A, B, C } = ctx);
});
afterAll(stop);

describe("Permissions — 'Goals view only' user (View(Global) only)", () => {
  let viewer;
  beforeAll(() => { viewer = ctx.client(A.viewOnly.token); });

  test("can list goals (200)", async () => expect((await viewer.get("/api/goals")).status).toBe(200));

  test("POST /api/goals → 403 (no Create) and nothing saved", async () => {
    const before = await Goal.countDocuments();
    const r = await viewer.post("/api/goals", validBody(A, { subject: "viewer created" }));
    expect({ status: r.status, saved: (await Goal.countDocuments()) - before }).toEqual({ status: 403, saved: 0 });
  });

  test("PUT /api/goals/:id → 403 (no Edit) and record unchanged", async () => {
    const id = A.goals[5]._id;
    const r = await viewer.put(`/api/goals/${id}`, { subject: "viewer edited" });
    expect({ status: r.status, subject: (await Goal.findById(id)).subject }).toEqual({ status: 403, subject: A.goals[5].subject });
  });

  test("DELETE /api/goals/:id → 403 (no Delete) and record kept", async () => {
    const id = A.goals[6]._id;
    const r = await viewer.del(`/api/goals/${id}`);
    expect({ status: r.status, exists: !!(await Goal.findById(id)) }).toEqual({ status: 403, exists: true });
  });

  test("Mass Delete path (one DELETE per id) → every call 403, nothing deleted", async () => {
    const ids = [A.goals[7]._id, A.goals[8]._id];
    const res = await Promise.all(ids.map((id) => viewer.del(`/api/goals/${id}`)));
    expect({ statuses: res.map((r) => r.status), left: await Goal.countDocuments({ _id: { $in: ids } }) }).toEqual({ statuses: [403, 403], left: 2 });
  });
});

describe("Permissions — other users", () => {
  test("no Goals permission → GET 403 'Forbidden: no View permission for Goals'", async () => {
    const r = await ctx.client(A.noAccess.token).get("/api/goals");
    expect(r.status).toBe(403);
    expect(r.body.message).toBe("Forbidden: no View permission for Goals");
  });

  test("no Goals permission → POST also 403", async () => {
    expect((await ctx.client(A.noAccess.token).post("/api/goals", validBody(A))).status).toBe(403);
  });

  test("Goals full (View+Create+Edit+Delete) user can create, edit, delete", async () => {
    const ed = ctx.client(A.full.token);
    const c = await ed.post("/api/goals", validBody(A, { subject: "editor goal" }));
    expect(c.status).toBe(201);
    expect((await ed.put(`/api/goals/${c.body._id}`, { subject: "editor goal 2" })).status).toBe(200);
    expect((await ed.del(`/api/goals/${c.body._id}`)).status).toBe(200);
  });

  test("Goals Create user WITHOUT Staff permission can load the Staff Member picker (GET /api/goals/options)", async () => {
    const r = await ctx.client(A.full.token).get("/api/goals/options");
    expect(r.status).toBe(200);
    expect(r.body.staff.length).toBeGreaterThan(0);
  });
});

describe("Plan gate (module_access.goals = false)", () => {
  test("GET /api/goals → 403 MODULE_DISABLED", async () => {
    const r = await ctx.client(C.admin.token).get("/api/goals");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_DISABLED");
  });
  test("POST /api/goals → 403 MODULE_DISABLED", async () => {
    const r = await ctx.client(C.admin.token).post("/api/goals", validBody(A));
    expect(r.body.code).toBe("MODULE_DISABLED");
  });
});

describe("Tenant isolation", () => {
  let api;
  beforeAll(() => { api = ctx.client(A.admin.token); });

  test("list never contains Tenant B goals; count = Tenant A DB count", async () => {
    const r = await api.get("/api/goals");
    expect(r.body.some((g) => /B Secret/.test(g.subject))).toBe(false);
    expect(r.body.length).toBe(await Goal.countDocuments({ tenant_id: A.tenantId }));
  });
  test("GET Tenant B goal by id → 404", async () => expect((await api.get(`/api/goals/${B.goals[0]._id}`)).status).toBe(404));
  test("PUT Tenant B goal by id → 404, unchanged", async () => {
    expect((await api.put(`/api/goals/${B.goals[1]._id}`, { subject: "x" })).status).toBe(404);
    expect((await Goal.findById(B.goals[1]._id)).subject).toBe("B Secret Goal 2");
  });
  test("DELETE Tenant B goal by id → 404, kept", async () => {
    expect((await api.del(`/api/goals/${B.goals[2]._id}`)).status).toBe(404);
    expect(await Goal.findById(B.goals[2]._id)).not.toBeNull();
  });
  test("staff dropdown (/api/staff) shows only Tenant A staff", async () => {
    const r = await api.get("/api/staff");
    const list = Array.isArray(r.body) ? r.body : r.body.data || r.body.staff || [];
    expect(r.status).toBe(200);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => String(s.tenant_id?._id || s.tenant_id) === String(A.tenantId))).toBe(true);
  });
  test("non-superadmin staff without tenant_id sees NO other tenants' goals", async () => {
    const r = await ctx.client(ctx.O.token).get("/api/goals");
    const leaked = r.status === 200 ? r.body.filter((g) => g.tenant_id).map((g) => g.subject) : [];
    expect(leaked).toEqual([]);
  });
  test("Tenant A can attach a Tenant B staff member to a goal and read B's staff name through populate", async () => {
    const r = await api.post("/api/goals", validBody(A, { subject: "cross-tenant staff", staff_member: String(B.pick[0]._id) }));
    const leaked = r.status === 201 ? (await api.get(`/api/goals/${r.body._id}`)).body.staff_member : null;
    expect(leaked).toBeNull();
  });
});
