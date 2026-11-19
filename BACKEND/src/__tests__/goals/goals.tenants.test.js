// Goals module — the core suites repeated for EVERY tenant (BeOnTime, CitySmile, Kiran,
// OffixNest, Rudraverse/Trinetra, Ekagra) + the goals:false plan tenant, and tenant
// isolation for every ordered pair. Fake test tenants, in-memory MongoDB only.
// Each test states the CORRECT behaviour; a failure = a bug.
// Test names start with "[<Tenant>] <area>" so the report can build a per-tenant matrix.
jest.setTimeout(600000);

const { bootTenants, stop, validBody, FIELD_CASES, TENANTS } = require("../../testUtils/goalsFixtures");

let ctx, T, Goal;
const KEYS = TENANTS.map((t) => t.key);
const PAIRS = KEYS.flatMap((a) => KEYS.filter((b) => b !== a).map((b) => [a, b]));

beforeAll(async () => {
  ctx = await bootTenants();
  ({ T, Goal } = ctx);
});
afterAll(stop);

const api = (who) => ctx.client(who.token);

describe.each(KEYS)("[%s]", (key) => {
  const t = () => T[key];
  const other = () => T[KEYS[(KEYS.indexOf(key) + 1) % KEYS.length]];

  describe("CRUD", () => {
    test("create (all fields) → 201, tenant_id = own tenant, DB matches", async () => {
      const body = validBody(t(), { subject: `${key} new`, goal_type: "estimates_conversion", notify_on_fail: false });
      const r = await api(t().admin).post("/api/goals", body);
      expect(r.status).toBe(201);
      const db = await Goal.findById(r.body._id).lean();
      expect(String(db.tenant_id)).toBe(String(t().tenantId));
      expect(db).toMatchObject({ subject: body.subject, goal_type: body.goal_type, achievement: Number(body.achievement), notify_on_fail: false });
    });
    test("list → only own goals, count = DB count", async () => {
      const r = await api(t().admin).get("/api/goals");
      expect(r.status).toBe(200);
      expect(r.body.every((g) => String(g.tenant_id) === String(t().tenantId))).toBe(true);
      expect(r.body.length).toBe(await Goal.countDocuments({ tenant_id: t().tenantId }));
    });
    test("view by id → 200 with staff populated", async () => {
      const r = await api(t().admin).get(`/api/goals/${t().goals[0]._id}`);
      expect(r.status).toBe(200);
      expect(r.body.staff_member.lastname).toBe(key);
    });
    test("edit every field → 200 and DB updated", async () => {
      const id = t().goals[1]._id;
      const r = await api(t().admin).put(`/api/goals/${id}`, { subject: `${key} edited`, goal_type: "convert_leads", achievement: "7", staff_member: String(t().pick[2]._id), start_date: "2026-11-05", end_date: "2026-11-20", description: "d", notify_on_achieve: false });
      expect(r.status).toBe(200);
      expect((await Goal.findById(id).lean())).toMatchObject({ subject: `${key} edited`, goal_type: "convert_leads", achievement: 7, notify_on_achieve: false });
    });
    test("delete → 'Goal deleted' and removed", async () => {
      const g = await Goal.create({ ...validBody(t()), tenant_id: t().tenantId });
      const r = await api(t().admin).del(`/api/goals/${g._id}`);
      expect(r.body.message).toBe("Goal deleted");
      expect(await Goal.findById(g._id)).toBeNull();
    });
  });

  describe("Field negatives (POST)", () => {
    const resolve = (v) => (v === "__B_STAFF__" ? String(other().pick[0]._id) : v === "__B_CT__" ? String(other().contractTypes[0]._id) : v);
    test.each(FIELD_CASES)("%s = %s → %s", async (field, _label, value, exp) => {
      const body = validBody(t(), { subject: `${key}-neg-${Math.random()}` });
      if (value === undefined) delete body[field]; else body[field] = resolve(value);
      const before = await Goal.countDocuments({ tenant_id: t().tenantId });
      const r = await api(t().admin).post("/api/goals", body);
      const saved = (await Goal.countDocuments({ tenant_id: t().tenantId })) - before;
      if (r.status === 201) await Goal.deleteOne({ _id: r.body._id });
      if (exp === "reject") expect({ status: r.status, saved }).toEqual({ status: r.status >= 400 && r.status < 500 ? r.status : "4xx", saved: 0 });
      else if (exp === "ignore") { expect(r.status).toBe(201); expect(r.body[field]).not.toEqual(value); }
      else expect({ status: r.status, saved }).toEqual({ status: 201, saved: 1 });
    });
  });

  describe("Permissions", () => {
    test("view-only: list → 200", async () => expect((await api(t().viewOnly).get("/api/goals")).status).toBe(200));
    test("view-only: POST → 403", async () => expect((await api(t().viewOnly).post("/api/goals", validBody(t()))).status).toBe(403));
    test("view-only: PUT → 403", async () => expect((await api(t().viewOnly).put(`/api/goals/${t().goals[2]._id}`, { subject: "viewer" })).status).toBe(403));
    test("view-only: DELETE → 403", async () => {
      const g = await Goal.create({ ...validBody(t()), tenant_id: t().tenantId });
      expect((await api(t().viewOnly).del(`/api/goals/${g._id}`)).status).toBe(403);
    });
    test("no Goals permission: GET → 403", async () => expect((await api(t().noAccess).get("/api/goals")).status).toBe(403));
    test("no token → 401", async () => expect((await ctx.client(null).get("/api/goals")).status).toBe(401));
  });

  describe("Plan gate", () => {
    test("plan with goals on → GET 200 (not MODULE_DISABLED)", async () => {
      const r = await api(t().admin).get("/api/goals");
      expect(r.body?.code).not.toBe("MODULE_DISABLED");
      expect(r.status).toBe(200);
    });
  });
});

describe("[NoGoalsPlan]", () => {
  describe("Plan gate", () => {
    test.each([["get", "/api/goals"], ["post", "/api/goals"], ["get", "/api/goals/64b000000000000000000000"]])(
      "%s %s → 403 MODULE_DISABLED", async (m, p) => {
        const r = await api(T.NoGoalsPlan.admin)[m](p, m === "post" ? validBody(T.NoGoalsPlan) : undefined);
        expect({ status: r.status, code: r.body?.code }).toEqual({ status: 403, code: "MODULE_DISABLED" });
      });
  });
});

describe("Tenant isolation — every ordered pair", () => {
  describe.each(PAIRS)("[%s] vs %s", (a, b) => {
    const A = () => T[a], B = () => T[b];
    test("list has none of B's goals", async () => {
      const r = await api(A().admin).get("/api/goals");
      expect(r.body.filter((g) => String(g.tenant_id) === String(B().tenantId))).toEqual([]);
    });
    test("view B goal → 404", async () => expect((await api(A().admin).get(`/api/goals/${B().goals[3]._id}`)).status).toBe(404));
    test("edit B goal → 404, unchanged", async () => {
      const id = B().goals[3]._id;
      const r = await api(A().admin).put(`/api/goals/${id}`, { subject: "hijacked" });
      expect({ status: r.status, subject: (await Goal.findById(id)).subject }).toEqual({ status: 404, subject: `${b} Goal 4` });
    });
    test("delete B goal → 404, kept", async () => {
      const r = await api(A().admin).del(`/api/goals/${B().goals[4]._id}`);
      expect({ status: r.status, kept: !!(await Goal.findById(B().goals[4]._id)) }).toEqual({ status: 404, kept: true });
    });
    test("PUT tenant_id = B on own goal does not move it", async () => {
      const g = await Goal.create({ ...validBody(A()), tenant_id: A().tenantId });
      await api(A().admin).put(`/api/goals/${g._id}`, { tenant_id: String(B().tenantId) });
      const moved = String((await Goal.findById(g._id)).tenant_id) !== String(A().tenantId);
      await Goal.deleteOne({ _id: g._id });
      expect(moved).toBe(false);
    });
    test("staff dropdown has none of B's staff", async () => {
      const r = await api(A().admin).get("/api/staff");
      const list = Array.isArray(r.body) ? r.body : r.body?.data || [];
      expect(list.filter((s) => String(s.tenant_id?._id || s.tenant_id) === String(B().tenantId))).toEqual([]);
    });
  });
});
