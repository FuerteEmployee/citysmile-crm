// Goals module — POSITIVE API tests, 05-goals.md section 2.
// In-memory MongoDB only. Each test states the CORRECT behaviour; a failure = a bug.
// UI side of the same flows is in CRM-FRONTEND-NEW/src/test/goals.ui.test.mjs.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { boot, stop, validBody, GOAL_TYPES } = require("../../testUtils/goalsFixtures");

let ctx, Goal, A, api;

beforeAll(async () => {
  ctx = await boot();
  ({ Goal, A } = ctx);
  api = ctx.client(A.admin.token);
});
afterAll(stop);

describe("Create (POST /api/goals) — all fields, each of the 8 goal types", () => {
  test.each(GOAL_TYPES)("goal_type %s → 201 and DB document matches every field", async (type) => {
    const body = validBody(A, {
      subject: `All fields ${type}`, goal_type: type, staff_member: String(A.pick[1]._id),
      achievement: "75000", start_date: "2026-11-01", end_date: "2027-01-31",
      description: "Full description", notify_on_achieve: false, notify_on_fail: true,
      ...(type.startsWith("contracts_by_type") ? { contract_type: String(A.contractTypes[0]._id) } : {}),
    });
    const r = await api.post("/api/goals", body);
    expect(r.status).toBe(201);
    const db = await Goal.findById(r.body._id).lean();
    expect(db.subject).toBe(body.subject);
    expect(db.goal_type).toBe(type);
    expect(String(db.staff_member)).toBe(body.staff_member);
    expect(db.achievement).toBe(75000);
    expect(db.start_date.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(db.end_date.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(db.description).toBe("Full description");
    expect(db.notify_on_achieve).toBe(false);
    expect(db.notify_on_fail).toBe(true);
    expect(db.progress).toBe(0);
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });

  test("new goal is returned by GET /api/goals (first, newest) with staff populated", async () => {
    const r = await api.post("/api/goals", validBody(A, { subject: "Newest goal" }));
    const list = await api.get("/api/goals");
    expect(list.body[0]._id).toBe(r.body._id);
    expect(list.body[0].staff_member.firstname).toBe("Pick");
  });
});

describe("Edit (PUT /api/goals/:id) — every field", () => {
  test("every field updates and the DB matches", async () => {
    const created = (await api.post("/api/goals", validBody(A, { subject: "To edit" }))).body;
    const upd = {
      subject: "Edited subject", goal_type: "convert_leads", staff_member: String(A.pick[2]._id),
      achievement: "12", start_date: "2026-12-01", end_date: "2026-12-15",
      description: "Edited desc", notify_on_achieve: false, notify_on_fail: false,
    };
    const r = await api.put(`/api/goals/${created._id}`, upd);
    expect(r.status).toBe(200);
    const db = await Goal.findById(created._id).lean();
    expect(db).toMatchObject({ subject: upd.subject, goal_type: upd.goal_type, achievement: 12, description: upd.description, notify_on_achieve: false, notify_on_fail: false });
    expect(String(db.staff_member)).toBe(upd.staff_member);
    expect(db.start_date.toISOString().slice(0, 10)).toBe("2026-12-01");
    expect(db.end_date.toISOString().slice(0, 10)).toBe("2026-12-15");
  });

  test("GET /api/goals/:id returns what the edit form needs (staff_member populated object)", async () => {
    const r = await api.get(`/api/goals/${A.goals[2]._id}`);
    expect(r.status).toBe(200);
    expect(typeof r.body.staff_member).toBe("object");
    expect(r.body.staff_member._id).toBe(String(A.pick[2]._id));
  });
});

describe("Delete", () => {
  test("DELETE → 'Goal deleted' and gone from list + DB", async () => {
    const g = (await api.post("/api/goals", validBody(A, { subject: "Delete me" }))).body;
    const r = await api.del(`/api/goals/${g._id}`);
    expect(r.body.message).toBe("Goal deleted");
    expect((await api.get("/api/goals")).body.some((x) => x._id === g._id)).toBe(false);
    expect(await Goal.findById(g._id)).toBeNull();
  });

  test("Mass Delete (UI sends one DELETE per id) removes all selected", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await api.post("/api/goals", validBody(A, { subject: `Bulk ${i}` }))).body._id);
    const res = await Promise.all(ids.map((id) => api.del(`/api/goals/${id}`)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await Goal.countDocuments({ _id: { $in: ids } })).toBe(0);
  });
});

describe("Progress tracking (goal_type text promises it is calculated)", () => {
  // Staff "Pick One" does real work inside the goal dates; progress should move off 0.
  let staffId, goalIds = {};
  const inRange = new Date();

  beforeAll(async () => {
    staffId = A.pick[0]._id;
    const db = mongoose.connection.db;
    const tenant_id = A.tenantId;
    const start = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    for (const type of GOAL_TYPES) {
      goalIds[type] = (await api.post("/api/goals", validBody(A, { subject: `Progress ${type}`, goal_type: type, staff_member: String(staffId), achievement: "2", start_date: start, end_date: end, contract_type: String(A.contractTypes[0]._id) }))).body._id;
    }
    const clientIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await db.collection("clients").insertMany(clientIds.map((_id, i) => ({ _id, company: `Won ${i}`, tenant_id, created_by: staffId, addedfrom: staffId, createdAt: inRange, active: true })));
    const inv = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await db.collection("invoices").insertMany(inv.map((_id, i) => ({ _id, client: clientIds[i], number: `G-INV-${i}`, total: 5000, subtotal: 5000, status: "paid", date: inRange, tenant_id, created_by: staffId, sale_agent: staffId, createdAt: inRange })));
    await db.collection("payments").insertMany(inv.map((id, i) => ({ invoiceid: id, customerid: clientIds[i], amount: 5000, date: inRange, tenant_id, created_by: staffId, createdAt: inRange })));
    await db.collection("leads").insertMany([0, 1].map((i) => ({ name: `Lead ${i}`, tenant_id, assigned: staffId, addedfrom: staffId, created_by: staffId, status: "converted", converted: true, date_converted: inRange, client_id: clientIds[i], createdAt: inRange })));
    await db.collection("contracts").insertMany([0, 1].map((i) => ({ client: clientIds[i], subject: `C ${i}`, contract_type: String(A.contractTypes[0]._id), datestart: inRange, start_date: inRange, tenant_id, created_by: staffId, addedfrom: staffId, createdAt: inRange })));
    await db.collection("estimates").insertMany([0, 1].map((i) => ({ client: clientIds[i], number: `G-EST-${i}`, subtotal: 1, total: 1, status: "accepted", invoice_id: inv[i], tenant_id, created_by: staffId, sale_agent: String(staffId), createdAt: inRange })));
  });

  test.each(GOAL_TYPES)("%s: progress moves above 0% after matching activity", async (type) => {
    const r = await api.get(`/api/goals/${goalIds[type]}`);
    expect(r.body.progress).toBeGreaterThan(0);
  });
});
