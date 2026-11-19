// HRMS Part A (People) + Part E (Branches) — API, field-rule, role, security and integration tests.
// test-prompts/04-hrms.md + 00-common-rules.md. Every test states the EXPECTED (business) rule;
// a failing test = a bug in the app (PROPOSED rules are treated as the real rules).
// In-memory MongoDB only (testUtils/startHrmsPeopleTestStack.js), backend on 127.0.0.1:5206.
// Run:  npx jest src/hrms/__tests__/hrms-people.api.test.js --runInBand
const { boot } = require("../../testUtils/startHrmsPeopleTestStack");

jest.setTimeout(180000);

let S; let T; let A; let B; let R; let OFF;
const PASSWORD = "Test@1234";
const XSS = "<script>alert(1)</script>";
const XSS2 = "<img src=x onerror=alert(1)>";
const missingId = "64b0000000000000000000dd";
let phone = 0;
const freshMobile = () => `98${String(70000000 + ++phone).slice(-8)}`;

function client(token) {
  const call = async (method, path, body, headers = {}) => {
    const h = { "Content-Type": "application/json", ...headers };
    if (token) h.Authorization = token.startsWith("RAW:") ? token.slice(4) : `Bearer ${token}`;
    const res = await fetch(S.baseUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: (p) => call("DELETE", p) };
}
const as = (u) => client(u.token);
const H = "/api/hrms";
const rows = (r) => (Array.isArray(r.body) ? r.body : r.body?.data || []);
const models = () => S.seed.M;

const resolve = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
async function newStaff(api, extra = {}) {
  const n = ++phone;
  return api.post(`${H}/users`, { name: `New Person ${n}`, email: `new${n}.${Date.now()}@hrms-people.test`, mobile: freshMobile(), password: PASSWORD, ...resolve(extra) });
}

beforeAll(async () => {
  S = await boot({ port: 5206, quiet: true });
  T = S.seed.T; A = T.A; B = T.B; R = T.R; OFF = T.OFF;
});
afterAll(async () => { if (S) await S.stop(); });

// ─────────────────────────────────────────────────────────── Phase 1 — Smoke (API side)
describe("P1 Smoke — every Part A/E list endpoint answers 200 for the company admin", () => {
  const eps = () => [
    "/users", `/users/${A.users.w1.userId}`, "/departments", "/designations", "/roles", "/users/device-approvals",
    "/users/session-logs", "/hrms-branches", `/hrms-branches/${A.branches.north._id}`, "/branch-types", "/hrms-branches/my-scope",
  ];
  test("admin A: all 200", async () => {
    const out = [];
    for (const e of eps()) out.push([e, (await as(A.users.admin).get(H + e)).status]);
    expect(out.filter(([, s]) => s !== 200)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────── Phase 2 — CRUD
describe("P2 CRUD — Departments", () => {
  let id;
  test("[+] create → saved in DB with uppercase code and company id", async () => {
    const r = await as(A.users.admin).post(`${H}/departments`, { name: "Accounts", code: "acc", description: "Money people" });
    expect(r.status).toBe(201);
    id = r.body.data._id;
    const d = await models().Department.findById(id).lean();
    expect(d.code).toBe("ACC");
    expect(String(d.tenant_id)).toBe(A.tenantId);
  });
  test("[+] read one / list contains it", async () => {
    expect((await as(A.users.admin).get(`${H}/departments/${id}`)).body.data.name).toBe("Accounts");
    expect(rows(await as(A.users.admin).get(`${H}/departments`)).some((d) => d._id === id)).toBe(true);
  });
  test("[+] edit → DB updated", async () => {
    expect((await as(A.users.admin).patch(`${H}/departments/${id}`, { name: "Accounts & Finance" })).status).toBe(200);
    expect((await models().Department.findById(id).lean()).name).toBe("Accounts & Finance");
  });
  test("[+] delete → gone from DB", async () => {
    expect((await as(A.users.admin).del(`${H}/departments/${id}`)).status).toBe(200);
    expect(await models().Department.findById(id)).toBeNull();
  });
  test("[I] delete a department that has staff is blocked (400)", async () => {
    expect((await as(A.users.admin).del(`${H}/departments/${A.dept._id}`)).status).toBe(400);
  });
});

describe("P2 CRUD — Designations", () => {
  let id;
  test("[+] create with level 5", async () => {
    const r = await as(A.users.admin).post(`${H}/designations`, { name: "Team Lead", code: "TL", level: 5 });
    expect(r.status).toBe(201);
    id = r.body.data._id;
    expect((await models().Designation.findById(id).lean()).level).toBe(5);
  });
  test("[+] edit level", async () => {
    expect((await as(A.users.admin).patch(`${H}/designations/${id}`, { level: 7 })).status).toBe(200);
    expect((await models().Designation.findById(id).lean()).level).toBe(7);
  });
  test("[+] delete", async () => {
    expect((await as(A.users.admin).del(`${H}/designations/${id}`)).status).toBe(200);
  });
  test("[I] delete a designation that has staff is blocked (400)", async () => {
    expect((await as(A.users.admin).del(`${H}/designations/${A.desig._id}`)).status).toBe(400);
  });
});

describe("P2 CRUD — Roles", () => {
  let id;
  test("[+] create / edit / delete a role", async () => {
    const c = await as(A.users.admin).post(`${H}/roles`, { role: "field_exec", label: "Field Executive", permissions: ["view_attendance"] });
    expect(c.status).toBe(201);
    id = c.body._id;
    expect((await as(A.users.admin).put(`${H}/roles/${id}`, { label: "Field Exec" })).body.label).toBe("Field Exec");
    expect((await as(A.users.admin).del(`${H}/roles/${id}`)).status).toBe(200);
  });
});

describe("P2 CRUD — Branches and Branch Types", () => {
  let id; let typeId;
  test("[+] create branch type", async () => {
    const r = await as(A.users.admin).post(`${H}/branch-types`, { name: "Warehouse", description: "Stock" });
    expect(r.status).toBe(201);
    typeId = r.body.data._id;
  });
  test("[+] create branch with all fields → saved", async () => {
    const r = await as(A.users.admin).post(`${H}/hrms-branches`, {
      name: "West A", branchType: typeId, addressLine1: "1 MG Road", city: "Vadodara", state: "Gujarat", pincode: "390001",
      phone: "9123456780", email: "west@a.test", latitude: 22.3, longitude: 73.18, radius: 300, geoFenceEnabled: true,
    });
    expect(r.status).toBe(201);
    id = r.body.data._id;
    const b = await models().Branch.findById(id).lean();
    expect([b.city, b.pincode, b.radius, String(b.branchType), String(b.tenant_id)]).toEqual(["Vadodara", "390001", 300, typeId, A.tenantId]);
  });
  test("[+] edit branch", async () => {
    expect((await as(A.users.admin).patch(`${H}/hrms-branches/${id}`, { city: "Anand", status: "Inactive" })).status).toBe(200);
    expect((await models().Branch.findById(id).lean()).city).toBe("Anand");
  });
  test("[+] edit / delete branch type", async () => {
    expect((await as(A.users.admin).patch(`${H}/branch-types/${typeId}`, { name: "Depot" })).status).toBe(200);
  });
  test("[+] delete empty branch", async () => {
    expect((await as(A.users.admin).del(`${H}/hrms-branches/${id}`)).status).toBe(200);
    expect(await models().Branch.findById(id)).toBeNull();
  });
});

describe("P2 CRUD — Staff (create / view / edit / delete / bulk)", () => {
  let created;
  test("[+] create staff → HRMS profile saved with company id", async () => {
    const r = await newStaff(as(A.users.admin), { salaryAmount: 31000, hrmsBranchId: String(A.branches.south._id), employeeCode: "A-NEW-1" });
    expect(r.status).toBe(201);
    created = r.body.data;
    const u = await models().User.findById(created._id).lean();
    expect([String(u.tenant_id), u.salaryAmount, String(u.hrmsBranchId)]).toEqual([A.tenantId, 31000, String(A.branches.south._id)]);
  });
  test("[+] view staff returns full details to admin", async () => {
    const r = await as(A.users.admin).get(`${H}/users/${created._id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.salaryAmount).toBe(31000);
  });
  test("[+] edit staff name / salary / bank → DB updated", async () => {
    const r = await as(A.users.admin).put(`${H}/users/${created._id}`, { name: "Edited Person", salaryAmount: 40000, bankInfo: { accountNumber: "123456789012", ifscCode: "sbin0001234" } });
    expect(r.status).toBe(200);
    const u = await models().User.findById(created._id).lean();
    expect([u.name, u.salaryAmount, u.bankInfo.ifscCode]).toEqual(["Edited Person", 40000, "SBIN0001234"]);
  });
  test("[+] delete staff → HRMS profile removed", async () => {
    expect((await as(A.users.admin).del(`${H}/users/${created._id}`)).status).toBe(200);
    expect(await models().User.findById(created._id)).toBeNull();
  });
  test("[+] bulk add 3 rows", async () => {
    const r = await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: [1, 2, 3].map((i) => ({ name: `Bulk ${i}`, email: `bulk${i}@a.hrms-people.test`, mobile: freshMobile() })) });
    expect(r.status).toBe(200);
    expect(r.body.data.success).toBe(3);
  });
  test("[-] bulk add 501 rows is refused (max 500)", async () => {
    const r = await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: Array.from({ length: 501 }, (_, i) => ({ name: `X${i}` })) });
    expect(r.status).toBe(400);
  });
  test("[+] bulk update moves 2 staff to South branch", async () => {
    const r = await as(A.users.admin).patch(`${H}/users/bulk-update`, { userIds: [A.users.dept.userId, A.users.desig.userId], updates: { hrmsBranchId: String(A.branches.south._id) } });
    expect(r.status).toBe(200);
    expect(r.body.data.matched).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────── Phase 3 — Search / filter / sort / pagination
describe("P3 Staff Directory search, filters, pagination (results checked)", () => {
  test("search 'Worker3' returns exactly Worker3", async () => {
    const r = await as(A.users.admin).get(`${H}/users?search=Worker3&limit=50`);
    expect(rows(r).map((u) => u.name)).toEqual(["Worker3 A"]);
  });
  test("search by mobile / email / employee code", async () => {
    expect(rows(await as(A.users.admin).get(`${H}/users?search=${A.users.w2.mobile}`)).map((u) => u.name)).toEqual(["Worker2 A"]);
    expect(rows(await as(A.users.admin).get(`${H}/users?search=w4.a@`)).length).toBe(1);
    expect(rows(await as(A.users.admin).get(`${H}/users?search=A-W1`)).length).toBe(1);
  });
  test("search with regex characters '(' and '.*' does not crash and is literal", async () => {
    const a = await as(A.users.admin).get(`${H}/users?search=(`);
    const b = await as(A.users.admin).get(`${H}/users?search=.*`);
    expect([a.status, b.status, rows(b).length]).toEqual([200, 200, 0]);
  });
  test("branch filter North = w1, w2, sup", async () => {
    const r = await as(A.users.admin).get(`${H}/users?hrmsBranchId=${A.branches.north._id}&limit=50`);
    expect(rows(r).map((u) => u.name).sort()).toEqual(["Worker1 A", "Worker2 A", "sup A"]);
  });
  test("status filter isActive=false only returns inactive staff", async () => {
    await models().User.updateOne({ _id: A.users.w4.userId }, { isActive: false });
    const r = await as(A.users.admin).get(`${H}/users?isActive=false&limit=50`);
    expect(rows(r).map((u) => u.name)).toEqual(["Worker4 A"]);
    await models().User.updateOne({ _id: A.users.w4.userId }, { isActive: true });
  });
  test("role filter by role id", async () => {
    const r = await as(A.users.admin).get(`${H}/users?role=${A.roles.deptmgr._id}&limit=50`);
    expect(rows(r).map((u) => u.name)).toEqual(["dept A"]);
  });
  test("pagination: page 1 + page 2 (limit 5) do not overlap and total is right", async () => {
    const p1 = await as(A.users.admin).get(`${H}/users?page=1&limit=5`);
    const p2 = await as(A.users.admin).get(`${H}/users?page=2&limit=5`);
    const all = await models().User.countDocuments({ tenant_id: A.tenantId });
    expect(p1.body.total).toBe(all);
    expect(p1.body.totalPages).toBe(Math.ceil(all / 5));
    const ids1 = rows(p1).map((u) => u._id);
    expect(rows(p2).some((u) => ids1.includes(u._id))).toBe(false);
  });
  test("page size is capped (limit=100000 must not dump the whole table)", async () => {
    const r = await as(A.users.admin).get(`${H}/users?limit=100000`);
    expect(r.body.limit).toBeLessThanOrEqual(500);
  });
  test("negative / text page values do not crash", async () => {
    const r1 = await as(A.users.admin).get(`${H}/users?page=-3&limit=-1`);
    const r2 = await as(A.users.admin).get(`${H}/users?page=abc&limit=xyz`);
    expect([r1.status, r2.status]).toEqual([200, 200]);
  });
});

describe("P3 Branch list search, filters, pagination", () => {
  test("search 'North' only returns North A", async () => {
    expect(rows(await as(A.users.admin).get(`${H}/hrms-branches?search=North`)).map((b) => b.name)).toEqual(["North A"]);
  });
  test("status filter Inactive", async () => {
    await models().Branch.create({ name: "Closed A", tenant_id: A.tenantId, status: "Inactive" });
    expect(rows(await as(A.users.admin).get(`${H}/hrms-branches?status=Inactive`)).map((b) => b.name)).toEqual(["Closed A"]);
  });
  test("branch type filter", async () => {
    expect(rows(await as(A.users.admin).get(`${H}/hrms-branches?branchType=${A.branchType._id}`)).map((b) => b.name)).toEqual(["North A"]);
  });
  test("pagination limit 1 page 2", async () => {
    const r = await as(A.users.admin).get(`${H}/hrms-branches?limit=1&page=2`);
    expect(rows(r).length).toBe(1);
    expect(r.body.pagination.total).toBeGreaterThanOrEqual(3);
  });
  test("search '(' (regex character) answers 200, not 500 [suspected bug 29]", async () => {
    expect((await as(A.users.admin).get(`${H}/hrms-branches?search=(`)).status).toBe(200);
  });
  test("search '.*' is treated as text (no match), not as a regex", async () => {
    expect(rows(await as(A.users.admin).get(`${H}/hrms-branches?search=.*`)).length).toBe(0);
  });
  test("branchType=abc answers 400, not 500", async () => {
    expect((await as(A.users.admin).get(`${H}/hrms-branches?branchType=abc`)).status).toBe(400);
  });
});

describe("P3 Session Logs and Device Approvals filters", () => {
  beforeAll(async () => {
    for (const u of [A.users.w1, A.users.w2]) {
      await fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: PASSWORD, deviceId: `dev-${u.key}` }) });
    }
  });
  test("session logs: search by name returns only that person", async () => {
    const r = await as(A.users.admin).get(`${H}/users/session-logs?search=Worker1`);
    expect(rows(r).length).toBeGreaterThan(0);
    expect(rows(r).every((l) => l.userId.name === "Worker1 A")).toBe(true);
  });
  test("session logs: search '(' answers 200, not 500 [suspected bug 29]", async () => {
    expect((await as(A.users.admin).get(`${H}/users/session-logs?search=(`)).status).toBe(200);
  });
  test("session logs: date filter", async () => {
    const r = await as(A.users.admin).get(`${H}/users/session-logs?date=2001-01-01`);
    expect(rows(r).length).toBe(0);
  });
  test("session logs: pagination limit=1 → total counts all", async () => {
    const r = await as(A.users.admin).get(`${H}/users/session-logs?limit=1&page=1`);
    expect(rows(r).length).toBe(1);
    expect(r.body.total).toBeGreaterThanOrEqual(2);
  });
  test("session logs: userId=abc answers 400, not 500", async () => {
    expect((await as(A.users.admin).get(`${H}/users/session-logs?userId=abc`)).status).toBe(400);
  });
  test("device approvals: status tabs return only that status", async () => {
    await fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: A.users.w1.email, password: PASSWORD, deviceId: "dev-other" }) });
    const p = rows(await as(A.users.admin).get(`${H}/users/device-approvals?status=pending`));
    expect(p.length).toBeGreaterThan(0);
    expect(p.every((d) => d.status === "pending")).toBe(true);
    expect(rows(await as(A.users.admin).get(`${H}/users/device-approvals?status=revoked`)).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────── Phase 4 — Role-based access (API)
describe("P4 Normal employee (no HRMS permission) gets 403 from every Part A/E admin API", () => {
  // Throw-away targets so a successful (buggy) call does not change the shared fixtures.
  const V = {};
  beforeAll(async () => {
    V.u1 = (await newStaff(as(A.users.admin))).body.data._id;
    V.u2 = (await newStaff(as(A.users.admin))).body.data._id;
    V.r1 = (await as(A.users.admin).post(`${H}/roles`, { role: "victim_role_1", label: "Victim 1" })).body._id;
    V.r2 = (await as(A.users.admin).post(`${H}/roles`, { role: "victim_role_2", label: "Victim 2" })).body._id;
    V.br = (await as(A.users.admin).post(`${H}/hrms-branches`, { name: "Victim Branch A" })).body.data._id;
    V.dp = (await as(A.users.admin).post(`${H}/departments`, { name: "Victim Dept", code: "VDP" })).body.data._id;
  });
  const cases = () => [
    ["POST /users (create colleague)", "post", "/users", { name: "Sneaky Add", email: `sneaky${Date.now()}@x.test`, mobile: freshMobile(), password: PASSWORD }],
    ["PUT /users/:id (edit colleague salary)", "put", `/users/${V.u1}`, { salaryAmount: 1 }],
    ["DELETE /users/:id", "del", `/users/${V.u2}`],
    ["POST /users/bulk-create", "post", "/users/bulk-create", { rows: [{ name: "Bulk Sneak" }] }],
    ["PATCH /users/bulk-update", "patch", "/users/bulk-update", { userIds: [V.u1], updates: { isActive: false } }],
    ["POST /import/bulk (Excel import)", "post", "/import/bulk", {}],
    ["GET /users (whole Staff Directory)", "get", "/users"],
    ["GET /roles", "get", "/roles"],
    ["POST /roles", "post", "/roles", { role: "emp_made", label: "Emp made", permissions: ["*"] }],
    ["PUT /roles/:id", "put", `/roles/${V.r1}`, { permissions: ["*"] }],
    ["DELETE /roles/:id", "del", `/roles/${V.r2}`],
    ["POST /departments", "post", "/departments", { name: "Emp Dept", code: "EMPD" }],
    ["PATCH /departments/:id", "patch", `/departments/${V.dp}`, { name: "Hacked" }],
    ["POST /designations", "post", "/designations", { name: "Emp Desig", code: "EMPX" }],
    ["GET /users/device-approvals", "get", "/users/device-approvals"],
    ["GET /users/session-logs", "get", "/users/session-logs"],
    ["POST /hrms-branches", "post", "/hrms-branches", { name: "Emp Branch" }],
    ["PATCH /hrms-branches/:id", "patch", `/hrms-branches/${V.br}`, { city: "Hacked" }],
    ["DELETE /hrms-branches/:id", "del", `/hrms-branches/${V.br}`],
    ["POST /branch-types", "post", "/branch-types", { name: "Emp Type" }],
  ];
  test.each([...Array(20).keys()])("case %i", async (i) => {
    const [label, m, p, b] = cases()[i];
    const r = await as(A.users.emp)[m](H + p, b);
    expect({ label, status: r.status }).toEqual({ label, status: 403 });
  });
});

describe("P4 Screen permissions (Setup → Roles) vs API permissions (HRMS role) [suspected bug 1]", () => {
  test("staff with ONLY Setup→Roles 'HRMS Staff Directory' can open Device Approvals API (page is shown to them)", async () => {
    expect((await as(A.users.dir).get(`${H}/users/device-approvals`)).status).toBe(200);
  });
  test("staff with Setup→Roles 'HRMS Staff Directory' can bulk-add (page is shown to them)", async () => {
    expect((await as(A.users.dir).post(`${H}/users/bulk-create`, { rows: [{ name: "Dir Bulk", email: `dirbulk${Date.now()}@a.test` }] })).status).toBe(200);
  });
  test("staff with Setup→Roles 'HRMS Attendance' (Session Logs page guard) can read session logs API", async () => {
    expect((await as(A.users.att).get(`${H}/users/session-logs`)).status).toBe(200);
  });
  test("staff with HRMS role 'directory' (manage_users) can open device approvals", async () => {
    expect((await as(A.users.dirH).get(`${H}/users/device-approvals`)).status).toBe(200);
  });
  test("Departments-only staff: can create department, cannot create designation or branch", async () => {
    expect((await as(A.users.dept).post(`${H}/departments`, { name: "Dept by dept", code: "DBD" })).status).toBe(201);
    expect((await as(A.users.dept).post(`${H}/designations`, { name: "No", code: "NOO" })).status).toBe(403);
    expect((await as(A.users.dept).post(`${H}/hrms-branches`, { name: "No branch" })).status).toBe(403);
  });
  test("Designations-only staff: can create designation, cannot create department", async () => {
    expect((await as(A.users.desig).post(`${H}/designations`, { name: "Desig by desig", code: "DBG" })).status).toBe(201);
    expect((await as(A.users.desig).post(`${H}/departments`, { name: "No", code: "NOD" })).status).toBe(403);
  });
  test("Branch View-only staff: cannot create / edit / delete a branch", async () => {
    expect((await as(A.users.brView).post(`${H}/hrms-branches`, { name: "View only made" })).status).toBe(403);
    expect((await as(A.users.brView).patch(`${H}/hrms-branches/${A.branches.south._id}`, { city: "x" })).status).toBe(403);
    expect((await as(A.users.brView).del(`${H}/hrms-branches/${A.branches.south._id}`)).status).toBe(403);
  });
  test("Branch full staff: can create / edit / delete a branch", async () => {
    const c = await as(A.users.brFull).post(`${H}/hrms-branches`, { name: "Full made A" });
    expect(c.status).toBe(201);
    expect((await as(A.users.brFull).patch(`${H}/hrms-branches/${c.body.data._id}`, { city: "Rajkot" })).status).toBe(200);
    expect((await as(A.users.brFull).del(`${H}/hrms-branches/${c.body.data._id}`)).status).toBe(200);
  });
  test("Branch full staff (not admin) cannot set supervisors (403)", async () => {
    expect((await as(A.users.brFull).patch(`${H}/hrms-branches/${A.branches.south._id}`, { supervisorIds: [A.users.brFull.userId] })).status).toBe(403);
  });
  test("Departments-only staff cannot edit staff salary", async () => {
    const v = (await newStaff(as(A.users.admin))).body.data._id;
    expect((await as(A.users.dept).put(`${H}/users/${v}`, { salaryAmount: 2 })).status).toBe(403);
  });
});

describe("P4 Branch supervisor sees and manages only own-branch staff", () => {
  test("Staff Directory for supervisor = North staff only", async () => {
    const names = rows(await as(A.users.sup).get(`${H}/users?limit=100`)).map((u) => u.name).sort();
    expect(names).toEqual(["Worker1 A", "Worker2 A", "sup A"]);
  });
  test("supervisor cannot open a South employee's profile", async () => {
    expect((await as(A.users.sup).get(`${H}/users/${A.users.w3.userId}`)).status).toBe(403);
  });
  test("supervisor cannot edit a South employee", async () => {
    expect((await as(A.users.sup).put(`${H}/users/${A.users.w3.userId}`, { name: "Changed by sup" })).status).toBe(403);
  });
  test("supervisor cannot make themself supervisor of South", async () => {
    expect((await as(A.users.sup).patch(`${H}/hrms-branches/${A.branches.south._id}`, { supervisorIds: [A.users.sup.userId] })).status).toBe(403);
  });
  test("my-scope tells the UI the supervisor's branches", async () => {
    const r = await as(A.users.sup).get(`${H}/hrms-branches/my-scope`);
    expect(r.body.data.branches.map((b) => b.name)).toEqual(["North A"]);
  });
});

describe("P4 Plan with HRMS module turned off", () => {
  test("Staff Directory API → 403 MODULE_DISABLED", async () => {
    const r = await as(OFF.users.admin).get(`${H}/users`);
    expect([r.status, r.body.code]).toEqual([403, "MODULE_DISABLED"]);
  });
  test("roles / device approvals / session logs → 403 MODULE_DISABLED", async () => {
    for (const p of ["/roles", "/users/device-approvals", "/users/session-logs"]) expect((await as(OFF.users.admin).get(H + p)).status).toBe(403);
  });
  test("branches list, departments, designations stay open", async () => {
    for (const p of ["/hrms-branches", "/departments", "/designations", "/hrms-branches/my-scope"]) expect((await as(OFF.users.admin).get(H + p)).status).toBe(200);
  });
  test("branch detail (Edit Branch page) stays open", async () => {
    expect((await as(OFF.users.admin).get(`${H}/hrms-branches/${OFF.branches.north._id}`)).status).toBe(200);
  });
  test("branch create / edit stay open (Branch Management is open without HRMS)", async () => {
    expect((await as(OFF.users.admin).post(`${H}/hrms-branches`, { name: "Off new branch" })).status).toBe(201);
    expect((await as(OFF.users.admin).patch(`${H}/hrms-branches/${OFF.branches.south._id}`, { city: "Bhuj" })).status).toBe(200);
  });
  test("branch types (tab of Branch Management) stay open", async () => {
    expect((await as(OFF.users.admin).get(`${H}/branch-types`)).status).toBe(200);
  });
  test("HRMS-native login stays open", async () => {
    const r = await fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: OFF.users.emp.email, password: PASSWORD }) });
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────── Phase 5 — Integration
describe("P5 Integration", () => {
  test("[I] staff created in HRMS gets a CRM login (Setup → Staff) that can sign in with the same password", async () => {
    const email = `crmlink${Date.now()}@a.hrms-people.test`;
    const r = await as(A.users.admin).post(`${H}/users`, { name: "Crm Link", email, mobile: freshMobile(), password: "Linked@123" });
    expect(r.status).toBe(201);
    const st = await models().Staff.findOne({ email }).lean();
    expect([!!st, String(st?.tenant_id), st?.is_hrms_staff]).toEqual([true, A.tenantId, true]);
    const login = await fetch(`${S.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Linked@123" }) });
    expect(login.status).toBe(200);
  });
  test("[I] editing name / mobile / active in HRMS updates the CRM login", async () => {
    const r = await newStaff(as(A.users.admin));
    const id = r.body.data._id;
    const mob = freshMobile();
    await as(A.users.admin).put(`${H}/users/${id}`, { name: "Renamed Twice", mobile: mob, isActive: false });
    const st = await models().Staff.findOne({ hrms_user_id: id }).lean() || await models().Staff.findById(r.body.data.staffId).lean();
    const u = await models().User.findById(id).lean();
    const st2 = await models().Staff.findById(u.staffId).lean();
    expect([st2.firstname, st2.lastname, st2.phonenumber, st2.active]).toEqual(["Renamed", "Twice", mob, false]);
    expect(st || st2).toBeTruthy();
  });
  test("[I] deleting staff deactivates their CRM login", async () => {
    const r = await newStaff(as(A.users.admin));
    const u = await models().User.findById(r.body.data._id).lean();
    await as(A.users.admin).del(`${H}/users/${u._id}`);
    expect((await models().Staff.findById(u.staffId).lean()).active).toBe(false);
  });
  test("[I][suspected bug 6] deleting a company-A profile never deactivates company B's login with the same email", async () => {
    const shared = B.users.w1.email;
    const u = await models().User.collection.insertOne({ name: "Legacy dup", email: shared, password: "x", tenant_id: new (require("mongoose").Types.ObjectId)(A.tenantId), staffId: null, isActive: true });
    await as(A.users.admin).del(`${H}/users/${u.insertedId}`);
    expect((await models().Staff.findById(B.users.w1.staffId).lean()).active).toBe(true);
  });
  test("[I] renaming a branch renames it on Items and Vendors of the same company only", async () => {
    const mongoose = require("mongoose");
    const db = mongoose.connection.db;
    const tA = new mongoose.Types.ObjectId(A.tenantId); const tB = new mongoose.Types.ObjectId(B.tenantId);
    await db.collection("items").insertMany([{ description: "Item A", branch: "South A", tenant_id: tA }, { description: "Item B", branch: "South A", tenant_id: tB }]);
    await db.collection("vendors").insertOne({ company: "Vendor A", branch: "South A", tenant_id: tA });
    expect((await as(A.users.admin).patch(`${H}/hrms-branches/${A.branches.south._id}`, { name: "South A Renamed" })).status).toBe(200);
    expect((await db.collection("items").findOne({ description: "Item A" })).branch).toBe("South A Renamed");
    expect((await db.collection("vendors").findOne({ company: "Vendor A" })).branch).toBe("South A Renamed");
    expect((await db.collection("items").findOne({ description: "Item B" })).branch).toBe("South A");
    await as(A.users.admin).patch(`${H}/hrms-branches/${A.branches.south._id}`, { name: "South A" });
  });
  test("[I][PROPOSED, suspected bug 33] deleting a branch that still has staff is blocked", async () => {
    const r = await as(A.users.admin).del(`${H}/hrms-branches/${B.branches.north._id}`);
    expect(r.status).toBe(404); // other company — must not be deletable at all
    const br = (await as(A.users.admin).post(`${H}/hrms-branches`, { name: "Has Staff A" })).body.data._id;
    await newStaff(as(A.users.admin), { hrmsBranchId: br });
    const own = await as(A.users.admin).del(`${H}/hrms-branches/${br}`);
    expect(own.status).toBe(400);
  });
  test("[I] device approval → approved device can log in; the person's other pending requests are closed [suspected bug 28]", async () => {
    const u = A.users.w3;
    const login = (deviceId) => fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: PASSWORD, deviceId }) });
    expect((await login("w3-phone")).status).toBe(200);
    expect((await login("w3-tab1")).status).toBe(403);
    expect((await login("w3-tab2")).status).toBe(403);
    const list = rows(await as(A.users.admin).get(`${H}/users/device-approvals?status=pending`));
    const one = list.find((d) => d.requestedDeviceId === "w3-tab1");
    expect((await as(A.users.admin).patch(`${H}/users/device-approvals/${one._id}/approve`)).status).toBe(200);
    expect((await login("w3-tab1")).status).toBe(200);
    const after = rows(await as(A.users.admin).get(`${H}/users/device-approvals?status=pending`));
    expect(after.some((d) => d.requestedDeviceId === "w3-tab2")).toBe(false);
  });
  test("[I] revoked device can no longer log in; rejected request cannot be approved later without a new request", async () => {
    const u = A.users.w4;
    const login = (deviceId) => fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: PASSWORD, deviceId }) });
    await login("w4-phone");
    await login("w4-new");
    const req = rows(await as(A.users.admin).get(`${H}/users/device-approvals?status=pending`)).find((d) => d.requestedDeviceId === "w4-new");
    expect((await as(A.users.admin).patch(`${H}/users/device-approvals/${req._id}/reject`)).status).toBe(200);
    expect((await login("w4-new")).status).toBe(403);
    // A rejected request should not flip to approved (status flow pending → approved/rejected only)
    expect((await as(A.users.admin).patch(`${H}/users/device-approvals/${req._id}/approve`)).status).toBe(400);
  });
  test("[I][suspected bug 28] CRM staff login (/api/auth/login) also obeys the device lock", async () => {
    const u = B.users.w2;
    const login = (deviceId) => fetch(`${S.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: PASSWORD, deviceId }) });
    expect((await login("crm-dev-1")).status).toBe(200);
    expect((await login("crm-dev-2")).status).toBe(403);
  });
  test("[I] CRM staff login writes a Session Log row", async () => {
    const u = B.users.w3;
    await fetch(`${S.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: PASSWORD }) });
    expect(rows(await as(B.users.admin).get(`${H}/users/session-logs?search=Worker3`)).length).toBeGreaterThan(0);
  });
  test("[I][suspected bug 27] 'Supervisor For Branches' on Staff Edit is saved and gives branch scope", async () => {
    await as(A.users.admin).put(`${H}/users/${A.users.w4.userId}`, { supervisorBranchIds: [String(A.branches.south._id)] });
    const r = await as(A.users.w4).get(`${H}/hrms-branches/my-scope`);
    expect(r.body.data.isSupervisor).toBe(true);
  });
  test("[I] changing a role key does not orphan staff (role still resolves)", async () => {
    const r = await as(A.users.admin).put(`${H}/roles/${A.roles.attendance._id}`, { role: "attendance_viewer" });
    expect(r.status).toBe(200);
    expect((await as(A.users.att).get(`${H}/users/session-logs`)).status).not.toBe(500);
  });
});

// ─────────────────────────────────────────────────────────── Phase 6 — Negative / field rules
const FIELD_RULES = [];
const rule = (form, field, label, run, expectOk) => FIELD_RULES.push({ form, field, label, run, expectOk });
const staffCreate = (extra) => async () => newStaff(as(A.users.admin), extra);
const staffEdit = (extra) => async () => as(A.users.admin).put(`${H}/users/${A.users.w2.userId}`, extra);
// Staff — create
rule("Staff", "Name", "empty → reject", staffCreate({ name: "" }), false);
rule("Staff", "Name", "spaces only → reject", staffCreate({ name: "    " }), false);
rule("Staff", "Name", "1 char → reject (min 2)", staffCreate({ name: "A" }), false);
rule("Staff", "Name", "100 chars → accept", staffCreate({ name: "N".repeat(100) }), true);
rule("Staff", "Name", "101 chars → reject (max 100, PROPOSED)", staffCreate({ name: "N".repeat(101) }), false);
rule("Staff", "Email", "not an email → reject", staffCreate({ email: "not-an-email" }), false);
rule("Staff", "Email", "255 chars → reject (max 254)", staffCreate({ email: `${"e".repeat(243)}@example.com` }), false);
rule("Staff", "Email", "duplicate in same company → reject", staffCreate({ email: () => A.users.w1.email }), false);
rule("Staff", "Mobile", "missing → reject", staffCreate({ mobile: "" }), false);
rule("Staff", "Mobile", "9 digits → reject", staffCreate({ mobile: "987654321" }), false);
rule("Staff", "Mobile", "letters → reject", staffCreate({ mobile: "98765abcde" }), false);
rule("Staff", "Mobile", "starts with 1 → reject (must start 6–9)", staffCreate({ mobile: "1234567890" }), false);
rule("Staff", "Mobile", "starts with 5 → reject (must start 6–9)", staffCreate({ mobile: "5876543210" }), false);
rule("Staff", "Mobile", "+91 prefix → accept", staffCreate({ mobile: () => `+91${freshMobile()}` }), true);
rule("Staff", "Mobile", "used in another company → reject", staffCreate({ mobile: () => B.users.w1.mobile }), false);
rule("Staff", "Password", "empty on create → reject", staffCreate({ password: "" }), false);
rule("Staff", "Password", "7 chars on create → reject (min 8)", staffCreate({ password: "Abc@123" }), false);
rule("Staff", "Residential phone", "'12345' → reject in BE", staffCreate({ residentialPhone: "12345" }), false);
rule("Staff", "Residential phone", "'1234567890' → reject (must start 6–9)", staffCreate({ residentialPhone: "1234567890" }), false);
rule("Staff", "Emergency phone", "'abc' → reject in BE", staffCreate({ emergencyContact: { name: "Mom", phone: "abc" } }), false);
rule("Staff", "Emergency phone", "'0123456789' → reject (must start 6–9)", staffCreate({ emergencyContact: { name: "Mom", phone: "0123456789" } }), false);
rule("Staff", "PAN", "valid ABCDE1234F → accept", staffCreate({ legalDocuments: { panNumber: "ABCDE1234F" } }), true);
rule("Staff", "PAN", "lower case abcde1234f → accept (auto upper-cased)", staffCreate({ legalDocuments: { panNumber: "abcde1234f" } }), true);
rule("Staff", "PAN", "9 chars → reject", staffCreate({ legalDocuments: { panNumber: "ABCDE1234" } }), false);
rule("Staff", "PAN", "11 chars → reject", staffCreate({ legalDocuments: { panNumber: "ABCDE1234FF" } }), false);
rule("Staff", "PAN", "wrong pattern 12345ABCDE → reject", staffCreate({ legalDocuments: { panNumber: "12345ABCDE" } }), false);
rule("Staff", "Aadhaar", "valid 234567890123 → accept", staffCreate({ legalDocuments: { aadhaarNumber: "234567890123" } }), true);
rule("Staff", "Aadhaar", "starts with 1 → reject", staffCreate({ legalDocuments: { aadhaarNumber: "123456789012" } }), false);
rule("Staff", "Aadhaar", "13 digits → reject", staffCreate({ legalDocuments: { aadhaarNumber: "2345678901234" } }), false);
rule("Staff", "Aadhaar", "11 digits → reject", staffCreate({ legalDocuments: { aadhaarNumber: "23456789012" } }), false);
rule("Staff", "IFSC", "valid SBIN0001234 → accept", staffCreate({ bankInfo: { ifscCode: "SBIN0001234" } }), true);
rule("Staff", "IFSC", "5th char not 0 → reject", staffCreate({ bankInfo: { ifscCode: "SBIN1001234" } }), false);
rule("Staff", "IFSC", "12 chars → reject", staffCreate({ bankInfo: { ifscCode: "SBIN00012345" } }), false);
rule("Staff", "Bank account", "8 digits → reject", staffCreate({ bankInfo: { accountNumber: "12345678" } }), false);
rule("Staff", "Bank account", "19 digits → reject", staffCreate({ bankInfo: { accountNumber: "1234567890123456789" } }), false);
rule("Staff", "Bank account", "letters → reject", staffCreate({ bankInfo: { accountNumber: "12345abc901" } }), false);
rule("Staff", "Bank account", "18 digits → accept", staffCreate({ bankInfo: { accountNumber: "123456789012345678" } }), true);
rule("Staff", "Salary", "-1 → reject", staffCreate({ salaryAmount: -1 }), false);
rule("Staff", "Salary", "'abc' → reject", staffCreate({ salaryAmount: "abc" }), false);
rule("Staff", "Salary part (basic)", "-5 → reject", staffCreate({ salaryConfig: { basic: { value: -5 } } }), false);
rule("Staff", "Salary part (hra)", "'abc' → reject", staffCreate({ salaryConfig: { hra: { value: "abc" } } }), false);
rule("Staff", "Employee code", "duplicate in same company → reject (PROPOSED)", staffCreate({ employeeCode: "A-W1" }), false);
rule("Staff", "Employee code", "same code in another company → accept", staffCreate({ employeeCode: "B-W1" }), true);
// Staff — edit (same rules must apply)
rule("Staff (edit)", "Name", "edit to '' → reject", staffEdit({ name: "" }), false);
rule("Staff (edit)", "Name", "edit to 1 char → reject", staffEdit({ name: "Z" }), false);
rule("Staff (edit)", "Name", "edit to 101 chars → reject", staffEdit({ name: "N".repeat(101) }), false);
rule("Staff (edit)", "Mobile", "edit to 'abc' → reject", staffEdit({ mobile: "abc" }), false);
rule("Staff (edit)", "Mobile", "edit to '1234567890' → reject (6–9)", staffEdit({ mobile: "1234567890" }), false);
rule("Staff (edit)", "Password", "edit to '1' → reject (min 8)", staffEdit({ password: "1" }), false);
rule("Staff (edit)", "Residential phone", "edit to '12' → reject", staffEdit({ residentialPhone: "12" }), false);
rule("Staff (edit)", "PAN", "edit to 'BAD' → reject", staffEdit({ legalDocuments: { panNumber: "BAD" } }), false);
rule("Staff (edit)", "Aadhaar", "edit to '0123' → reject", staffEdit({ legalDocuments: { aadhaarNumber: "0123" } }), false);
rule("Staff (edit)", "IFSC", "edit to 'XYZ' → reject", staffEdit({ bankInfo: { ifscCode: "XYZ" } }), false);
rule("Staff (edit)", "Salary", "edit to -100 → reject", staffEdit({ salaryAmount: -100 }), false);
rule("Staff (edit)", "Employee code", "edit to another person's code → reject (PROPOSED)", staffEdit({ employeeCode: "A-W3" }), false);
// Departments
const deptCreate = (body) => async () => as(A.users.admin).post(`${H}/departments`, { name: `D${++phone}`, code: `C${phone}`, ...resolve(body) });
rule("Department", "Name", "empty → reject", deptCreate({ name: "" }), false);
rule("Department", "Name", "spaces only → reject", deptCreate({ name: "   " }), false);
rule("Department", "Name", "1 char → reject (min 2)", deptCreate({ name: "Q" }), false);
rule("Department", "Name", "101 chars → reject (max 100, PROPOSED)", deptCreate({ name: "D".repeat(101) }), false);
rule("Department", "Name", "duplicate in same company → reject", deptCreate({ name: "Sales A" }), false);
rule("Department", "Name", "same name in another company → accept", deptCreate({ name: "Sales B" }), true);
rule("Department", "Code", "1 char → reject (min 2)", deptCreate({ code: "Q" }), false);
rule("Department", "Code", "21 chars → reject (max 20, PROPOSED)", deptCreate({ code: "C".repeat(21) }), false);
rule("Department", "Code", "duplicate code → reject", deptCreate({ code: "SLSA" }), false);
rule("Department", "Code", "duplicate code typed in lower case → reject", deptCreate({ code: "slsa" }), false);
rule("Department", "Manager", "managerId 'abc' → reject with 400", deptCreate({ managerId: "abc" }), false);
rule("Department", "Manager", "manager from another company → reject", deptCreate({ managerId: () => B.users.w1.userId }), false);
rule("Department (edit)", "Name", "edit to duplicate → reject", async () => as(A.users.admin).patch(`${H}/departments/${(await as(A.users.admin).post(`${H}/departments`, { name: "Edit Dup", code: "EDD" })).body.data._id}`, { name: "Sales A" }), false);
rule("Department (edit)", "Name", "edit to 1 char → reject", async () => as(A.users.admin).patch(`${H}/departments/${A.dept._id}`, { name: "Q" }), false);
// Designations
const desigCreate = (body) => async () => as(A.users.admin).post(`${H}/designations`, { name: `G${++phone}`, code: `K${phone}`, ...resolve(body) });
rule("Designation", "Name", "empty → reject", desigCreate({ name: "" }), false);
rule("Designation", "Name", "1 char → reject (min 2)", desigCreate({ name: "Q" }), false);
rule("Designation", "Name", "duplicate in same company → reject", desigCreate({ name: "Manager A" }), false);
rule("Designation", "Code", "1 char → reject (min 2)", desigCreate({ code: "Q" }), false);
rule("Designation", "Code", "duplicate code → reject", desigCreate({ code: "MGRA" }), false);
rule("Designation", "Level", "0 → reject", desigCreate({ level: 0 }), false);
rule("Designation", "Level", "101 → reject", desigCreate({ level: 101 }), false);
rule("Designation", "Level", "1.5 → reject", desigCreate({ level: 1.5 }), false);
rule("Designation", "Level", "'abc' → reject", desigCreate({ level: "abc" }), false);
rule("Designation", "Level", "100 → accept", desigCreate({ level: 100 }), true);
rule("Designation", "Department", "departmentId of another company → reject", desigCreate({ departmentId: () => String(B.dept._id) }), false);
// Branches
const brCreate = (body) => async () => as(A.users.admin).post(`${H}/hrms-branches`, { name: `Br ${++phone}`, ...body });
const brEdit = (body) => async () => as(A.users.admin).patch(`${H}/hrms-branches/${A.branches.south._id}`, body);
rule("Branch", "Name", "empty → reject", brCreate({ name: "" }), false);
rule("Branch", "Name", "spaces only → reject", brCreate({ name: "   " }), false);
rule("Branch", "Name", "duplicate in same company → reject", brCreate({ name: "North A" }), false);
rule("Branch", "Name", "duplicate with different case/spaces → reject", brCreate({ name: " north a " }), false);
rule("Branch", "Name", "same name in another company → accept", brCreate({ name: "North B" }), true);
rule("Branch", "Phone", "mobile 9876543210 → accept", brCreate({ phone: "9876543210" }), true);
rule("Branch", "Phone", "landline with STD 079-26561234 → accept", brCreate({ phone: "079-26561234" }), true);
rule("Branch", "Phone", "1234567890 (not 6–9, no STD 0) → reject (PROPOSED)", brCreate({ phone: "1234567890" }), false);
rule("Branch", "Phone", "5555555555 → reject (PROPOSED)", brCreate({ phone: "5555555555" }), false);
rule("Branch", "Phone", "letters → reject", brCreate({ phone: "98765abcde" }), false);
rule("Branch", "Phone", "9 digits → reject", brCreate({ phone: "987654321" }), false);
rule("Branch", "PIN", "380001 → accept", brCreate({ pincode: "380001" }), true);
rule("Branch", "PIN", "012345 (starts with 0) → reject", brCreate({ pincode: "012345" }), false);
rule("Branch", "PIN", "5 digits → reject", brCreate({ pincode: "38000" }), false);
rule("Branch", "PIN", "7 digits → reject", brCreate({ pincode: "3800011" }), false);
rule("Branch", "Email", "bad email → reject", brCreate({ email: "x@" }), false);
rule("Branch", "Latitude", "91 → reject", brCreate({ latitude: 91, longitude: 72 }), false);
rule("Branch", "Latitude", "-90 → accept", brCreate({ latitude: -90, longitude: 72 }), true);
rule("Branch", "Latitude", "'abc' → reject", brCreate({ latitude: "abc", longitude: 72 }), false);
rule("Branch", "Longitude", "-181 → reject", brCreate({ latitude: 22, longitude: -181 }), false);
rule("Branch", "Longitude", "180 → accept", brCreate({ latitude: 22, longitude: 180 }), true);
rule("Branch", "Geofence radius", "0 with geofence on → reject", brCreate({ geoFenceEnabled: true, radius: 0, latitude: 22, longitude: 72 }), false);
rule("Branch", "Geofence radius", "100001 → reject", brCreate({ geoFenceEnabled: true, radius: 100001, latitude: 22, longitude: 72 }), false);
rule("Branch", "Geofence radius", "100000 → accept", brCreate({ geoFenceEnabled: true, radius: 100000, latitude: 22, longitude: 72 }), true);
rule("Branch", "Geofence radius", "-5 with geofence off → reject", brCreate({ radius: -5 }), false);
rule("Branch", "Geofence", "geofence on without latitude/longitude → reject", brCreate({ geoFenceEnabled: true, radius: 300 }), false);
rule("Branch", "Status", "status 'Banana' → reject", brCreate({ status: "Banana" }), false);
rule("Branch (edit)", "PIN", "edit to 012345 → reject", brEdit({ pincode: "012345" }), false);
rule("Branch (edit)", "Phone", "edit to 1234567890 → reject (PROPOSED)", brEdit({ phone: "1234567890" }), false);
rule("Branch (edit)", "Name", "edit to duplicate 'North A' → reject", brEdit({ name: "North A" }), false);
rule("Branch (edit)", "Name", "edit to empty → reject", brEdit({ name: "" }), false);
rule("Branch type", "Name", "empty → reject", async () => as(A.users.admin).post(`${H}/branch-types`, { name: "" }), false);
rule("Branch type", "Name", "duplicate → reject", async () => as(A.users.admin).post(`${H}/branch-types`, { name: "Retail A" }), false);
rule("Role", "Key/Label", "missing → reject", async () => as(A.users.admin).post(`${H}/roles`, { label: "" }), false);
rule("Role", "Key", "duplicate key → reject", async () => as(A.users.admin).post(`${H}/roles`, { role: "deptmgr", label: "dup" }), false);
rule("Role", "Permissions", "unknown permission string 'fly_to_moon' → reject", async () => as(A.users.admin).post(`${H}/roles`, { role: `r${++phone}`, label: "x", permissions: ["fly_to_moon"] }), false);

describe("P6 Field rules (expected business rule; API bypass of the screen)", () => {
  test.each(FIELD_RULES.map((r, i) => [i, `${r.form} › ${r.field} › ${r.label}`]))("#%i %s", async (i) => {
    const r = FIELD_RULES[i];
    // resolve lazy values (other company ids etc.)
    const res = await r.run();
    const ok = res.status >= 200 && res.status < 300;
    expect({ rule: `${r.form} ${r.field} ${r.label}`, status: res.status, accepted: ok }).toEqual(expect.objectContaining({ accepted: r.expectOk }));
    expect(res.status).toBeLessThan(500);
  });
});

describe("P6 Other negatives", () => {
  test("lower case IFSC/PAN are stored upper case", async () => {
    const r = await newStaff(as(A.users.admin), { legalDocuments: { panNumber: "pqrst6789z" }, bankInfo: { ifscCode: "hdfc0001234" } });
    const u = await models().User.findById(r.body.data._id).lean();
    expect([u.legalDocuments.panNumber, u.bankInfo.ifscCode]).toEqual(["PQRST6789Z", "HDFC0001234"]);
  });
  test("leading / trailing spaces in name are trimmed", async () => {
    const r = await newStaff(as(A.users.admin), { name: "   Trim Me   " });
    expect((await models().User.findById(r.body.data._id).lean()).name).toBe("Trim Me");
  });
  test("double-click Save (2 identical create requests at once) creates only one staff", async () => {
    const body = { name: "Double Click", email: `dbl${Date.now()}@a.hrms-people.test`, mobile: freshMobile(), password: PASSWORD };
    const rs = await Promise.all([as(A.users.admin).post(`${H}/users`, body), as(A.users.admin).post(`${H}/users`, body)]);
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(await models().User.countDocuments({ email: body.email })).toBe(1);
  });
  test("double-click Save on Department creates only one", async () => {
    const rs = await Promise.all([1, 2, 3].map(() => as(A.users.admin).post(`${H}/departments`, { name: "Twin Dept", code: "TWN" })));
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
  });
  test("deleted-record links: GET / PUT / DELETE a deleted staff → 404", async () => {
    const r = await newStaff(as(A.users.admin));
    const id = r.body.data._id;
    await as(A.users.admin).del(`${H}/users/${id}`);
    expect([(await as(A.users.admin).get(`${H}/users/${id}`)).status, (await as(A.users.admin).put(`${H}/users/${id}`, { name: "Ghost" })).status, (await as(A.users.admin).del(`${H}/users/${id}`)).status]).toEqual([404, 404, 404]);
  });
  test("device approval on a deleted request id → 404", async () => {
    expect((await as(A.users.admin).patch(`${H}/users/device-approvals/${missingId}/approve`)).status).toBe(404);
  });
  test("bulk add: a row with bad PAN / IFSC / Aadhaar is rejected (same rules as the form)", async () => {
    const r = await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: [{ name: "Bulk Bad Docs", email: `bbd${Date.now()}@a.test`, mobile: freshMobile(), panNumber: "BAD", ifscCode: "XYZ", aadhaarNumber: "1111" }] });
    expect(r.body.data.failed).toBe(1);
  });
  test("bulk add: a row without mobile is rejected (mobile is required)", async () => {
    const r = await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: [{ name: "Bulk No Mobile", email: `bnm${Date.now()}@a.test` }] });
    expect(r.body.data.failed).toBe(1);
  });
  test("bulk add: no default password '12345678' is given to new staff", async () => {
    const email = `bdp${Date.now()}@a.hrms-people.test`;
    await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: [{ name: "Bulk Default Pw", email, mobile: freshMobile() }] });
    const login = await fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "12345678" }) });
    expect(login.status).not.toBe(200);
  });
  test("bulk add: an employee code already used in the company is rejected (PROPOSED unique)", async () => {
    const r = await as(A.users.admin).post(`${H}/users/bulk-create`, { rows: [{ name: "Bulk Dup Code", email: `bdc${Date.now()}@a.test`, mobile: freshMobile(), employeeCode: "A-W2" }] });
    expect(r.body.data.failed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────── Phase 9 — API status codes
describe("P9 API — no token / bad token → 401, wrong company → 404, bad id → 400/404 (never 500)", () => {
  const eps = () => [
    ["get", "/users"], ["post", "/users"], ["get", `/users/${A.users.w1.userId}`], ["put", `/users/${A.users.w1.userId}`], ["del", `/users/${A.users.w1.userId}`],
    ["post", "/users/bulk-create"], ["patch", "/users/bulk-update"], ["get", "/users/device-approvals"], ["get", "/users/session-logs"],
    ["get", "/roles"], ["post", "/roles"], ["get", "/departments"], ["post", "/departments"], ["get", "/designations"], ["post", "/designations"],
    ["get", "/hrms-branches"], ["post", "/hrms-branches"], ["get", `/hrms-branches/${A.branches.north._id}`], ["get", "/branch-types"], ["post", "/branch-types"],
  ];
  test("no token → 401 on every endpoint", async () => {
    const bad = [];
    for (const [m, p] of eps()) { const r = await client(null)[m](H + p, {}); if (r.status !== 401) bad.push(`${m} ${p} → ${r.status}`); }
    expect(bad).toEqual([]);
  });
  test("bad token → 401 on every endpoint", async () => {
    const bad = [];
    for (const [m, p] of eps()) { const r = await client("not.a.token")[m](H + p, {}); if (r.status !== 401) bad.push(`${m} ${p} → ${r.status}`); }
    expect(bad).toEqual([]);
  });
  test("token signed with another secret → 401", async () => {
    const forged = require("jsonwebtoken").sign({ id: A.users.admin.staffId, role: "staff" }, "wrong-secret");
    expect((await client(forged).get(`${H}/users`)).status).toBe(401);
  });
  test("company B cannot read / edit / delete company A records (404)", async () => {
    const b = as(B.users.admin);
    const out = {
      getUser: (await b.get(`${H}/users/${A.users.w1.userId}`)).status,
      putUser: (await b.put(`${H}/users/${A.users.w1.userId}`, { name: "B was here" })).status,
      delUser: (await b.del(`${H}/users/${A.users.w1.userId}`)).status,
      getDept: (await b.get(`${H}/departments/${A.dept._id}`)).status,
      patchDept: (await b.patch(`${H}/departments/${A.dept._id}`, { name: "B" })).status,
      delDesig: (await b.del(`${H}/designations/${A.desig._id}`)).status,
      getBranch: (await b.get(`${H}/hrms-branches/${A.branches.north._id}`)).status,
      patchBranch: (await b.patch(`${H}/hrms-branches/${A.branches.north._id}`, { city: "B" })).status,
      delBranchType: (await b.del(`${H}/branch-types/${A.branchType._id}`)).status,
      putRole: (await b.put(`${H}/roles/${A.roles.deptmgr._id}`, { label: "B" })).status,
    };
    expect(Object.values(out).every((s) => s === 404 || s === 403)).toBe(true);
  });
  test("company B lists contain no company A rows", async () => {
    const b = as(B.users.admin);
    const lists = await Promise.all(["/users?limit=500", "/departments", "/designations", "/hrms-branches?limit=500", "/branch-types", "/roles", "/users/device-approvals", "/users/session-logs?limit=100"].map((p) => b.get(H + p)));
    expect(lists.map((l) => JSON.stringify(l.body)).some((s) => s.includes(A.tenantId) || / A"/.test(s))).toBe(false);
  });
  test("bad id 'abc' → 400 or 404 on every :id endpoint, never 500", async () => {
    const a = as(A.users.admin);
    const out = [
      (await a.get(`${H}/users/abc`)).status, (await a.put(`${H}/users/abc`, { name: "x y" })).status, (await a.del(`${H}/users/abc`)).status,
      (await a.get(`${H}/departments/abc`)).status, (await a.patch(`${H}/departments/abc`, { name: "xx" })).status, (await a.del(`${H}/departments/abc`)).status,
      (await a.get(`${H}/designations/abc`)).status, (await a.del(`${H}/designations/abc`)).status,
      (await a.get(`${H}/hrms-branches/abc`)).status, (await a.patch(`${H}/hrms-branches/abc`, { city: "x" })).status, (await a.del(`${H}/hrms-branches/abc`)).status,
      (await a.get(`${H}/branch-types/abc`)).status, (await a.del(`${H}/branch-types/abc`)).status,
      (await a.put(`${H}/roles/abc`, { label: "x" })).status, (await a.del(`${H}/roles/abc`)).status,
      (await a.patch(`${H}/users/device-approvals/abc/approve`)).status,
    ];
    expect(out.filter((s) => s >= 500)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────── Phase 10 — Security
describe("P10 Security", () => {
  test("[High] normal employee cannot change the company admin's password (account takeover)", async () => {
    const r = await as(A.users.emp).put(`${H}/users/${A.users.admin.userId}`, { password: "Owned@1234" });
    expect(r.status).toBe(403);
  });
  test("[High] after the attempt above the admin's CRM password still works and the new one does not", async () => {
    const ok = await fetch(`${S.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: A.users.admin.email, password: PASSWORD }) });
    const hacked = await fetch(`${S.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: A.users.admin.email, password: "Owned@1234" }) });
    expect([ok.status, hacked.status]).toEqual([200, 401]);
  });
  test("[High] normal employee cannot raise their own salary", async () => {
    await as(A.users.emp).put(`${H}/users/${A.users.emp.userId}`, { salaryAmount: 999999 });
    expect((await models().User.findById(A.users.emp.userId).lean()).salaryAmount).toBe(25000);
  });
  test("[High] privilege escalation: employee creates an 'owner' role and a new user with it, then logs in as an HRMS admin", async () => {
    const e = as(B.users.emp);
    const role = await e.post(`${H}/roles`, { role: "owner", label: "Owner", permissions: ["*"] });
    const email = `escalate${Date.now()}@b.hrms-people.test`;
    const user = await e.post(`${H}/users`, { name: "Escalated User", email, mobile: freshMobile(), password: PASSWORD, role: role.body?._id });
    const login = await fetch(`${S.baseUrl}${H}/users/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    const tok = (await login.json().catch(() => ({}))).token;
    const adminApi = tok ? await client(tok).get(`${H}/users/device-approvals`) : { status: 0 };
    expect({ role: role.status, user: user.status, adminApi: adminApi.status }).toEqual({ role: 403, user: 403, adminApi: 0 });
  });
  test("[High] employee cannot create a user with the company's existing admin role", async () => {
    const r = await as(R.users.emp).post(`${H}/users`, { name: "Admin Clone", email: `clone${Date.now()}@r.test`, mobile: freshMobile(), password: PASSWORD, role: String(R.roles.admin._id) });
    expect(r.status).toBe(403);
  });
  test("[High] admin cannot assign another company's role to a new staff member", async () => {
    const r = await newStaff(as(A.users.admin), { role: String(B.roles.admin._id) });
    expect(r.status).toBe(400);
  });
  test("[High] employee cannot give their own role ['*'] by editing the role", async () => {
    const r = await as(A.users.att).put(`${H}/roles/${A.roles.attendance._id}`, { permissions: ["view_attendance", "*"] });
    await require("../models/role_model").updateOne({ _id: A.roles.attendance._id }, { permissions: ["view_attendance"] });
    expect(r.status).toBe(403);
  });
  test("[High] employee cannot delete a colleague", async () => {
    const victim = await newStaff(as(A.users.admin));
    const r = await as(A.users.emp).del(`${H}/users/${victim.body.data._id}`);
    expect(r.status).toBe(403);
  });
  test("[Med] employee GET /users does not leak salary, bank or ID documents", async () => {
    const list = rows(await as(A.users.emp).get(`${H}/users?limit=100`));
    expect(list.some((u) => u.salaryAmount !== undefined || u.bankInfo !== undefined || u.legalDocuments !== undefined || u.password !== undefined)).toBe(false);
  });
  test("[Med] admin list never returns password hashes", async () => {
    const list = rows(await as(A.users.admin).get(`${H}/users?limit=100`));
    expect(list.some((u) => u.password)).toBe(false);
  });
  test("[Med] device approvals list does not leak registered device ids of other companies", async () => {
    const s = JSON.stringify((await as(B.users.admin).get(`${H}/users/device-approvals`)).body);
    expect(s.includes("w3-tab")).toBe(false);
  });
  test("NoSQL injection in query (isActive[$ne]) is not passed to the database", async () => {
    const r = await as(A.users.admin).get(`${H}/users?isActive[$ne]=zzz&limit=200`);
    expect(r.status).toBe(400);
  });
  test("NoSQL injection in session log userId[$ne] is refused", async () => {
    const r = await as(A.users.admin).get(`${H}/users/session-logs?userId[$ne]=1`);
    expect(r.status).toBe(400);
  });
  test("NoSQL injection object as department name is refused", async () => {
    const r = await as(A.users.admin).post(`${H}/departments`, { name: { $ne: null }, code: "NOSQL" });
    expect(r.status).toBe(400);
  });
  test("NoSQL injection in branch filters (status[$ne]) is refused", async () => {
    const r = await as(A.users.admin).get(`${H}/hrms-branches?status[$ne]=x`);
    expect(r.status).toBe(400);
  });
  test("ReDoS-style search on session logs does not hang (< 2 s)", async () => {
    const t = Date.now();
    await as(A.users.admin).get(`${H}/users/session-logs?search=${encodeURIComponent("(a+)+$")}`);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  test("XSS text is stored as plain text (React escapes it) and never as HTML-executing markup in JSON", async () => {
    const r = await as(A.users.admin).post(`${H}/departments`, { name: XSS, code: "XSS1", description: XSS2 });
    expect(r.status).toBe(201);
    expect(r.body.data.name).toBe(XSS);
  });
  test("tenant_id in body cannot move a record to another company", async () => {
    const r = await as(A.users.admin).post(`${H}/hrms-branches`, { name: "Smuggled", tenant_id: B.tenantId });
    expect(String((await models().Branch.findById(r.body.data._id).lean()).tenant_id)).toBe(A.tenantId);
    const e = await as(A.users.admin).put(`${H}/users/${A.users.w1.userId}`, { tenant_id: B.tenantId });
    expect(e.status).toBe(200);
    expect(String((await models().User.findById(A.users.w1.userId).lean()).tenant_id)).toBe(A.tenantId);
  });
  test("staff can be put only into branches / departments of their own company", async () => {
    const r = await as(A.users.admin).put(`${H}/users/${A.users.w1.userId}`, { hrmsBranchId: String(B.branches.north._id), department: String(B.dept._id) });
    expect(r.status).toBe(400);
  });
  test("admin cannot make a company-B employee supervisor of a company-A branch", async () => {
    const r = await as(A.users.admin).patch(`${H}/hrms-branches/${A.branches.south._id}`, { supervisorIds: [B.users.w1.userId] });
    expect(r.status).toBe(403);
  });
  test("bulk-update cannot touch another company's staff", async () => {
    const r = await as(A.users.admin).patch(`${H}/users/bulk-update`, { userIds: [B.users.w2.userId], updates: { isActive: false } });
    expect(r.body.data.matched).toBe(0);
    expect((await models().User.findById(B.users.w2.userId).lean()).isActive).toBe(true);
  });
  test("Rudraverse tenant behaves the same as other companies (no special HRMS rules)", async () => {
    const r = await as(R.users.admin).get(`${H}/users?limit=100`);
    expect(r.status).toBe(200);
    expect(rows(r).length).toBe(await models().User.countDocuments({ tenant_id: R.tenantId }));
    expect((await as(R.users.emp).get(`${H}/users/device-approvals`)).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────── Phase 11 — Performance (local numbers only)
describe("P11 Performance — 1,000 staff, 20 users at once, 500-row bulk add", () => {
  const timings = {};
  beforeAll(async () => {
    const { seedBulkStaff } = require("../../testUtils/hrms-people.seed");
    await seedBulkStaff(A.tenantId, 1000);
  });
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[PERF] ${JSON.stringify(timings)}`);
    require("fs").mkdirSync(require("path").resolve(__dirname, "../../../../test-results/hrms-people"), { recursive: true });
    require("fs").writeFileSync(require("path").resolve(__dirname, "../../../../test-results/hrms-people/perf.json"), JSON.stringify(timings, null, 2));
  });
  const time = async (k, fn) => { const t = Date.now(); const r = await fn(); timings[k] = Date.now() - t; return r; };
  test("Staff Directory page 1 (25 rows) < 1500 ms", async () => {
    const r = await time("users_page1_ms", () => as(A.users.admin).get(`${H}/users?page=1&limit=25`));
    expect(r.body.total).toBeGreaterThan(1000);
    expect(timings.users_page1_ms).toBeLessThan(1500);
  });
  test("Staff Directory page 40 < 1500 ms", async () => {
    await time("users_page40_ms", () => as(A.users.admin).get(`${H}/users?page=40&limit=25`));
    expect(timings.users_page40_ms).toBeLessThan(1500);
  });
  test("search across 1,000 staff < 1500 ms and correct", async () => {
    const r = await time("users_search_ms", () => as(A.users.admin).get(`${H}/users?search=Perf%20Staff%200999`));
    expect(rows(r).length).toBe(1);
    expect(timings.users_search_ms).toBeLessThan(1500);
  });
  test("20 users at once on Staff Directory: all 200, p95 < 3000 ms", async () => {
    const ts = [];
    const rs = await Promise.all(Array.from({ length: 20 }, async () => { const t = Date.now(); const r = await as(A.users.admin).get(`${H}/users?page=1&limit=25`); ts.push(Date.now() - t); return r.status; }));
    ts.sort((a, b) => a - b);
    timings.concurrent20_users_p95_ms = ts[18]; timings.concurrent20_users_max_ms = ts[19];
    expect(rs.every((s) => s === 200)).toBe(true);
    expect(ts[18]).toBeLessThan(3000);
  });
  test("20 users at once on Branch list: all 200", async () => {
    const t = Date.now();
    const rs = await Promise.all(Array.from({ length: 20 }, () => as(A.users.admin).get(`${H}/hrms-branches?limit=10`)));
    timings.concurrent20_branches_total_ms = Date.now() - t;
    expect(rs.every((r) => r.status === 200)).toBe(true);
  });
  test("bulk add 500 rows finishes < 120 s and adds 500", async () => {
    const r = await time("bulk500_ms", () => as(A.users.admin).post(`${H}/users/bulk-create`, { rows: Array.from({ length: 500 }, (_, i) => ({ name: `Bulk Perf ${i}`, email: `bulkperf${i}@a.hrms-people.test`, mobile: `6${String(200000000 + i)}` })) }));
    expect(r.body.data.success).toBe(500);
    expect(timings.bulk500_ms).toBeLessThan(120000);
  });
});
