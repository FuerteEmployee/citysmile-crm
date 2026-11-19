// Goals module — UNIT tests (model + controller), 05-goals.md section 1.
// In-memory MongoDB only. Each test states the CORRECT behaviour; a failure = a bug.
jest.setTimeout(120000);

const fs = require("fs");
const path = require("path");
const { boot, stop, validBody } = require("../../testUtils/goalsFixtures");

let ctx, Goal, A, B, api;

beforeAll(async () => {
  ctx = await boot();
  ({ Goal, A, B } = ctx);
  api = ctx.client(A.admin.token);
});
afterAll(stop);

describe("Goal model", () => {
  const base = () => ({ subject: "S", staff_member: A.pick[0]._id, achievement: "10", start_date: new Date(), end_date: new Date(), goal_type: "total_income" });

  test.each(["subject", "staff_member", "achievement", "start_date", "end_date", "goal_type"])(
    "%s is required",
    (field) => {
      const body = base();
      delete body[field];
      const err = new Goal(body).validateSync();
      expect(err && err.errors[field]).toBeTruthy();
    }
  );

  test("defaults: progress 0, notify_on_achieve true, notify_on_fail true", () => {
    const g = new Goal(base());
    expect(g.progress).toBe(0);
    expect(g.notify_on_achieve).toBe(true);
    expect(g.notify_on_fail).toBe(true);
  });

  test("staff_member refs Staff and contract_type refs ContractType", () => {
    expect(Goal.schema.path("staff_member").options.ref).toBe("Staff");
    expect(Goal.schema.path("contract_type").options.ref).toBe("ContractType");
  });

  test("achievement is numeric ('abc' is rejected)", () => {
    expect(Goal.schema.path("achievement").instance).toBe("Number");
    expect(new Goal({ ...base(), achievement: "abc" }).validateSync()).toBeTruthy();
  });

  test("achievement cannot be negative ('-500' is rejected)", () => {
    expect(new Goal({ ...base(), achievement: "-500" }).validateSync()).toBeTruthy();
  });

  test("goal_type is limited to the 8 known types", () => {
    expect(Goal.schema.path("goal_type").enumValues || []).toHaveLength(8);
    expect(new Goal({ ...base(), goal_type: "xyz" }).validateSync()).toBeTruthy();
  });

  test("end_date before start_date is rejected", () => {
    const err = new Goal({ ...base(), start_date: new Date("2026-12-31"), end_date: new Date("2026-01-01") }).validateSync();
    expect(err).toBeTruthy();
  });

  test("subject of only spaces is rejected (trim + required)", () => {
    expect(new Goal({ ...base(), subject: "   " }).validateSync()).toBeTruthy();
  });
});

describe("Goal controller", () => {
  test("createGoal returns 201 and sets tenant_id from the token", async () => {
    const r = await api.post("/api/goals", validBody(A, { subject: "Unit create" }));
    expect(r.status).toBe(201);
    expect(String(r.body.tenant_id)).toBe(String(A.tenantId));
  });

  test("getGoals: only own tenant, staff_member populated with firstname/lastname, newest first", async () => {
    const r = await api.get("/api/goals");
    expect(r.status).toBe(200);
    expect(r.body.every((g) => String(g.tenant_id) === String(A.tenantId))).toBe(true);
    expect(r.body.some((g) => /B Secret/.test(g.subject))).toBe(false);
    const withStaff = r.body.find((g) => g.staff_member);
    // firstname/lastname (+ virtuals id/full_name) only — no email/password/permissions leak.
    expect(withStaff.staff_member.firstname).toBeTruthy();
    expect(withStaff.staff_member).not.toHaveProperty("email");
    expect(withStaff.staff_member).not.toHaveProperty("password");
    const times = r.body.map((g) => new Date(g.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("getGoalById returns the goal; unknown id → 404 'Goal not found'", async () => {
    const ok = await api.get(`/api/goals/${A.goals[0]._id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.subject).toBe(A.goals[0].subject);
    const miss = await api.get("/api/goals/64b000000000000000000000");
    expect(miss.status).toBe(404);
    expect(miss.body.message).toBe("Goal not found");
  });

  test("updateGoal runs validators (subject null rejected, record unchanged)", async () => {
    const id = A.goals[1]._id;
    const r = await api.put(`/api/goals/${id}`, { subject: null });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await Goal.findById(id)).subject).toBe(A.goals[1].subject);
  });

  test("validation errors return 400, not 500 (POST with no fields)", async () => {
    const r = await api.post("/api/goals", {});
    expect(r.status).toBe(400);
  });

  test("CastError returns 400, not 500 (GET /api/goals/abc)", async () => {
    const r = await api.get("/api/goals/abc");
    expect(r.status).toBe(400);
  });

  test("deleteGoal responds { message: 'Goal deleted' }", async () => {
    const g = await Goal.create({ ...validBody(A), tenant_id: A.tenantId });
    const r = await api.del(`/api/goals/${g._id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ message: "Goal deleted" });
    expect(await Goal.findById(g._id)).toBeNull();
  });

  test("createGoal ignores client-sent progress", async () => {
    const r = await api.post("/api/goals", validBody(A, { progress: 99 }));
    expect(r.body.progress).toBe(0);
  });

  test("createGoal ignores client-sent _id", async () => {
    const forced = "64b0000000000000000000aa";
    const r = await api.post("/api/goals", validBody(A, { _id: forced }));
    expect(String(r.body._id)).not.toBe(forced);
  });

  test("updateGoal cannot move a goal to another tenant (tenant_id in body)", async () => {
    const g = await Goal.create({ ...validBody(A), tenant_id: A.tenantId });
    await api.put(`/api/goals/${g._id}`, { tenant_id: String(B.tenantId) });
    expect(String((await Goal.findById(g._id)).tenant_id)).toBe(String(A.tenantId));
  });

  test("createGoal rejects a staff_member from another tenant", async () => {
    const r = await api.post("/api/goals", validBody(A, { staff_member: String(B.pick[0]._id) }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("createGoal rejects a contract_type from another tenant", async () => {
    const r = await api.post("/api/goals", validBody(A, { goal_type: "contracts_by_type_added", contract_type: String(B.contractTypes[0]._id) }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("a non-superadmin user with no tenant_id does NOT see every tenant's goals", async () => {
    const r = await ctx.client(ctx.O.token).get("/api/goals");
    expect(r.status === 200 ? r.body.some((g) => /B Secret/.test(g.subject)) : false).toBe(false);
  });
});

describe("Backend logic that should exist for goals (source scan)", () => {
  const SRC = path.join(__dirname, "../..");
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "__tests__", "testUtils", "scratch"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  walk(SRC);
  const usesGoalModel = files.filter((f) => /require\([^)]*models\/Goal["']\)/.test(fs.readFileSync(f, "utf8")));

  test("some backend code calculates goal progress from goal_type / achievement", () => {
    const writers = usesGoalModel.filter((f) => /progress/.test(fs.readFileSync(f, "utf8")) && !/models[\\/]Goal\.js$/.test(f) && !/goal_controller/.test(f));
    expect(writers.map((f) => path.relative(SRC, f))).not.toEqual([]);
  });

  test("notify_on_achieve / notify_on_fail are used by some notifier", () => {
    const users = files.filter((f) => !/models[\\/]Goal\.js$/.test(f) && /notify_on_(achieve|fail)/.test(fs.readFileSync(f, "utf8")));
    expect(users).not.toEqual([]);
  });
});
