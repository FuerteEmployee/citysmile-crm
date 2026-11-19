// Goals module — NEGATIVE API tests for every field (POST and PUT), 05-goals.md section 3.
// In-memory MongoDB only. Each test states the CORRECT behaviour; a failure = a bug.
// Convention: "rejected" = 4xx (never 500) and nothing saved / record unchanged.
// "accepted" cases are inputs that are valid and must be saved as sent.
jest.setTimeout(180000);

const { boot, stop, validBody, FIELD_CASES: CASES } = require("../../testUtils/goalsFixtures");

let ctx, Goal, A, B, api, putTarget;

// POST a valid body with one field replaced (undefined = field removed).
const tryCreate = async (field, value) => {
  const body = validBody(A, { subject: `neg-${field}-${Math.random()}` });
  if (value === undefined) delete body[field]; else body[field] = value;
  if (field === "subject" && value !== undefined) body.subject = value;
  const before = await Goal.countDocuments({ tenant_id: A.tenantId });
  const r = await api.post("/api/goals", body);
  const after = await Goal.countDocuments({ tenant_id: A.tenantId });
  if (r.status === 201) await Goal.deleteOne({ _id: r.body._id });
  return { status: r.status, saved: after - before, body: r.body };
};
// PUT one field on an existing goal; restore afterwards.
const tryUpdate = async (field, value) => {
  const before = await Goal.findById(putTarget).lean();
  const r = await api.put(`/api/goals/${putTarget}`, { [field]: value });
  const after = await Goal.findById(putTarget).lean();
  await Goal.replaceOne({ _id: putTarget }, before);
  return { status: r.status, changed: JSON.stringify(after?.[field]) !== JSON.stringify(before[field]), stored: after?.[field], body: r.body };
};
const expectRejected = (res) => {
  // One assertion, so a failure shows both the status and whether it was saved.
  const saved = res.saved ?? (res.changed ? 1 : 0);
  expect({ status: res.status, saved }).toEqual({ status: res.status >= 400 && res.status < 500 ? res.status : "4xx", saved: 0 });
};

beforeAll(async () => {
  ctx = await boot();
  ({ Goal, A, B } = ctx);
  api = ctx.client(A.admin.token);
  putTarget = A.goals[4]._id;
});
afterAll(stop);

const resolve = (v) => (v === "__B_STAFF__" ? String(B.pick[0]._id) : v === "__B_CT__" ? String(B.contractTypes[0]._id) : v);

describe("POST /api/goals — every field", () => {
  test.each(CASES)("%s = %s → %s", async (field, _label, value, exp) => {
    const res = await tryCreate(field, resolve(value));
    if (exp === "reject") expectRejected(res);
    else if (exp === "ignore") { expect(res.status).toBe(201); expect(res.body[field]).not.toEqual(value); }
    else { expect(res.status).toBe(201); expect(res.saved).toBe(1); }
  });

  test("duplicate subject is allowed (no unique rule) — observed", async () => {
    const r1 = await tryCreate("subject", "Dup subject");
    const r2 = await tryCreate("subject", "Dup subject");
    expect([r1.status, r2.status]).toEqual([201, 201]);
  });
});

describe("PUT /api/goals/:id — every field", () => {
  const PUT_CASES = CASES.filter(([, , v]) => v !== undefined);
  test.each(PUT_CASES)("%s = %s → %s", async (field, _label, value, exp) => {
    const res = await tryUpdate(field, resolve(value));
    if (exp === "reject") expectRejected(res);
    else if (exp === "ignore") { expect(res.status).toBe(200); expect(res.changed).toBe(false); }
    else expect(res.status).toBe(200);
  });
});

describe("Auth, ids, mass assignment", () => {
  test("no token → 401", async () => expect((await ctx.client(null).get("/api/goals")).status).toBe(401));
  test("bad token → 401", async () => expect((await ctx.client("not.a.jwt").get("/api/goals")).status).toBe(401));
  test.each(["get", "put", "del"])("%s /api/goals/abc → 400/404, never 500", async (m) => {
    const r = await api[m]("/api/goals/abc", m === "put" ? { subject: "x" } : undefined);
    expect([400, 404]).toContain(r.status);
  });
  test("tenant_id in POST body is ignored (token tenant wins)", async () => {
    const r = await api.post("/api/goals", validBody(A, { tenant_id: String(B.tenantId) }));
    expect(String(r.body.tenant_id)).toBe(String(A.tenantId));
  });
  test("_id in POST body is ignored", async () => {
    const forced = "64b0000000000000000000ab";
    const r = await api.post("/api/goals", validBody(A, { _id: forced }));
    expect(r.body._id).not.toBe(forced);
  });
  test("createdAt in POST body is ignored", async () => {
    const r = await api.post("/api/goals", validBody(A, { createdAt: "2000-01-01T00:00:00.000Z" }));
    expect(new Date(r.body.createdAt).getFullYear()).not.toBe(2000);
  });
  test("PUT tenant_id = Tenant B does not move the goal", async () => {
    const res = await tryUpdate("tenant_id", String(B.tenantId));
    expect(res.changed).toBe(false);
  });
  test("PUT createdAt is ignored", async () => {
    const res = await tryUpdate("createdAt", "2000-01-01T00:00:00.000Z");
    expect(res.changed).toBe(false);
  });
  test("PUT on a Tenant B goal id → 404 and B goal unchanged", async () => {
    const r = await api.put(`/api/goals/${B.goals[0]._id}`, { subject: "hacked" });
    expect(r.status).toBe(404);
    expect((await Goal.findById(B.goals[0]._id)).subject).toBe("B Secret Goal 1");
  });
  test("PUT on a deleted goal id → 404 'Goal not found'", async () => {
    const g = await Goal.create({ ...validBody(A), tenant_id: A.tenantId });
    await Goal.deleteOne({ _id: g._id });
    const r = await api.put(`/api/goals/${g._id}`, { subject: "ghost" });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("Goal not found");
  });
});

describe("Bulk delete and deleted staff", () => {
  test("Mass Delete where one id fails: UI uses Promise.all → others are already deleted (partial delete)", async () => {
    const g1 = await Goal.create({ ...validBody(A, { subject: "bulk ok" }), tenant_id: A.tenantId });
    const results = await Promise.all([api.del(`/api/goals/${g1._id}`), api.del("/api/goals/abc")]);
    // Each DELETE stands alone: the valid id is deleted, the bad id gets a 400, and the
    // UI (Promise.allSettled) reports how many were deleted and how many failed.
    expect(results.map((r) => r.status)).toEqual([200, 400]);
    expect(await Goal.findById(g1._id)).toBeNull();
  });

  test("goal of a deleted staff member: list still loads, staff_member is null (UI shows empty name)", async () => {
    const s = await ctx.Staff.create({ firstname: "Gone", lastname: "Soon", email: "gone@crm-test.local", password: "x", tenant_id: A.tenantId });
    const g = await Goal.create({ ...validBody(A, { subject: "Orphaned goal", staff_member: s._id }), tenant_id: A.tenantId });
    await ctx.Staff.deleteOne({ _id: s._id });
    const r = await api.get("/api/goals");
    expect(r.status).toBe(200);
    const row = r.body.find((x) => x._id === String(g._id));
    expect(row.staff_member).toBeNull();
  });
});
