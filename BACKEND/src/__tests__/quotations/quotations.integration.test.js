// Quotation Maker -- PHASE 3 integration tests.
// Covers: permissions, tenant isolation, mass-assignment, stats consistency.
// A FAILING test means a real security or correctness bug. Do NOT change app code.
jest.setTimeout(180000);

const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client } = require("./quotationStack.cjs");

let A, B, Quotation, QuotationType;
const as = (u) => client(u.token);
const freshId = () => new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  await start();
  ({ A, B } = await seedAll());
  Quotation     = require("../../models/Quotation");
  QuotationType = require("../../models/QuotationType");
});
afterAll(stop);

// =============================================================================
//  HELPER: create a quotation in Tenant A as admin, return doc
// =============================================================================
const mkQ = async (extra = {}) => {
  const r = await as(A.users.admin).post("/api/quotations", { status: "draft", ...extra });
  if (r.status !== 201) throw new Error(`mkQ failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// =============================================================================
//  WRITE SWEEP -- permissions
// =============================================================================
// quotation_routes.js uses only `protect` (no checkPermission) for the main
// quotation CRUD routes (lines 9-15).  That means noPerm and settingsView can
// currently list/create/edit/delete quotations -- a HIGH security finding.
// Each 2xx from a restricted user is recorded as HIGH.

describe("WRITE SWEEP -- noPerm and settingsView should be denied (HIGH finding if 2xx)", () => {
  let qId;
  beforeAll(async () => {
    await setFeatures(A.tenantId, []);
    const q = await mkQ({ client: String(A.customers[0]._id) });
    qId = q._id;
  });

  const LOW_PRIV_USERS = ["noPerm", "settingsView"];

  // ── Quotation writes ──────────────────────────────────────────────────────
  test.each(LOW_PRIV_USERS)("%s: POST /api/quotations -- should 403, 2xx = HIGH FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).post("/api/quotations", { status: "draft" });
    // FINDING: no checkPermission on this route, so r.status will be 201 not 403
    if (r.status >= 200 && r.status < 300) {
      // Clean up stray document
      if (r.body && r.body._id) await Quotation.findByIdAndDelete(r.body._id);
      console.warn(`[HIGH FINDING] ${userKey} can POST /api/quotations -> ${r.status}`);
    }
    // Test expectation documents correct behaviour (403)
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: PUT /api/quotations/:id -- should 403, 2xx = HIGH FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).put(`/api/quotations/${qId}`, { notes: "pwned" });
    if (r.status >= 200 && r.status < 300) {
      console.warn(`[HIGH FINDING] ${userKey} can PUT /api/quotations/:id -> ${r.status}`);
    }
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: DELETE /api/quotations/:id -- should 403, 2xx = HIGH FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).del(`/api/quotations/${qId}`);
    if (r.status >= 200 && r.status < 300) {
      console.warn(`[HIGH FINDING] ${userKey} can DELETE /api/quotations/:id -> ${r.status}`);
    }
    expect(r.status).toBe(403);
  });

  // ── Approval actions ──────────────────────────────────────────────────────
  describe("approval actions require Approve permission (403 for non-approvers)", () => {
    beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
    afterAll(()  => setFeatures(A.tenantId, []));

    test.each([...LOW_PRIV_USERS, "maker"])(
      "%s: POST request-approval -- allowed for any authed user (just needs approval add-on)",
      async (userKey) => {
        const q = await mkQ({ client: String(A.customers[0]._id) });
        const r = await as(A.users[userKey]).post(`/api/quotations/${q._id}/request-approval`);
        // request-approval: any authenticated user CAN request (no specific permission guard beyond protect)
        expect(r.status).not.toBe(500);
      }
    );

    test.each([...LOW_PRIV_USERS, "maker"])(
      "%s: POST /approve -- must be 403 (needs Quotations Approve)", async (userKey) => {
        const q = await mkQ({ client: String(A.customers[0]._id) });
        await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
        const r = await as(A.users[userKey]).post(`/api/quotations/${q._id}/approve`, {});
        // Only admin/approver can approve; others must get 403
        if ([...LOW_PRIV_USERS, "maker"].includes(userKey)) {
          expect(r.status).toBe(403);
        }
      }
    );

    test.each([...LOW_PRIV_USERS, "maker"])(
      "%s: POST /reject -- must be 403 (needs Quotations Approve)", async (userKey) => {
        const q = await mkQ({ client: String(A.customers[0]._id) });
        await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
        const r = await as(A.users[userKey]).post(`/api/quotations/${q._id}/reject`, { comment: "reason" });
        if ([...LOW_PRIV_USERS, "maker"].includes(userKey)) {
          expect(r.status).toBe(403);
        }
      }
    );

    test.each([...LOW_PRIV_USERS, "maker"])(
      "%s: GET /approvals/pending -- must be 403 (needs Quotations Approve)", async (userKey) => {
        const r = await as(A.users[userKey]).get("/api/quotations/approvals/pending");
        expect(r.status).toBe(403);
      }
    );
  });

  // ── Quotation type writes -- governed by Settings permission ───────────────
  test.each(LOW_PRIV_USERS)("%s: POST /api/quotation-types -- 403", async (userKey) => {
    const r = await as(A.users[userKey]).post("/api/quotation-types", {
      name: `NoPerm-${Date.now()}`, format: "both",
    });
    // checkPermission("Settings","Create") guards this
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: PUT /api/quotation-types/:id -- 403", async (userKey) => {
    const r = await as(A.users[userKey]).put(`/api/quotation-types/${A.types.electrical._id}`, { name: "Hacked" });
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: PUT /api/quotation-types/reorder -- 403", async (userKey) => {
    const r = await as(A.users[userKey]).put("/api/quotation-types/reorder", {
      items: [{ id: String(A.types.electrical._id), order: 99 }],
    });
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: DELETE /api/quotation-types/:id -- 403", async (userKey) => {
    const r = await as(A.users[userKey]).del(`/api/quotation-types/${A.types.electrical._id}`);
    expect(r.status).toBe(403);
  });

  // ── Reads: noPerm/settingsView should not list quotations ─────────────────
  // FINDING: no permission guard on GET /api/quotations or GET /api/quotation-types
  test.each(LOW_PRIV_USERS)("%s: GET /api/quotations -- should 403, 2xx = HIGH FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).get("/api/quotations");
    if (r.status >= 200 && r.status < 300) {
      console.warn(`[HIGH FINDING] ${userKey} can GET /api/quotations -> ${r.status}`);
    }
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: GET /api/quotation-types -- should 403, 2xx = HIGH FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).get("/api/quotation-types");
    if (r.status >= 200 && r.status < 300) {
      console.warn(`[HIGH FINDING] ${userKey} can GET /api/quotation-types -> ${r.status}`);
    }
    // No permission guard on GET /api/quotation-types (quotation_type_routes.js:15)
    expect(r.status).toBe(403);
  });

  test.each(LOW_PRIV_USERS)("%s: GET /api/quotations/stats -- should 403, 2xx = FINDING", async (userKey) => {
    const r = await as(A.users[userKey]).get("/api/quotations/stats");
    if (r.status >= 200 && r.status < 300) {
      console.warn(`[FINDING] ${userKey} can GET /api/quotations/stats -> ${r.status}`);
    }
    expect(r.status).toBe(403);
  });
});

// =============================================================================
//  TENANT ISOLATION
//  Tenant A tokens must not see or change Tenant B's data
// =============================================================================
describe("tenant isolation -- Tenant A tokens on Tenant B resources", () => {
  test("GET /api/quotations/:id (Tenant B id) -- 404", async () => {
    const r = await as(A.users.admin).get(`/api/quotations/${B.quotations[0]._id}`);
    expect(r.status).toBe(404);
  });

  test("PUT /api/quotations/:id (Tenant B id) -- 404, B doc unchanged", async () => {
    const before = await Quotation.findById(B.quotations[0]._id).lean();
    const r = await as(A.users.admin).put(`/api/quotations/${B.quotations[0]._id}`, { notes: "pwned" });
    expect(r.status).toBe(404);
    const after = await Quotation.findById(B.quotations[0]._id).lean();
    expect(after.notes).toBe(before.notes);
  });

  test("DELETE /api/quotations/:id (Tenant B id) -- 404, B doc still exists", async () => {
    const r = await as(A.users.admin).del(`/api/quotations/${B.quotations[0]._id}`);
    expect(r.status).toBe(404);
    expect(await Quotation.findById(B.quotations[0]._id)).not.toBeNull();
  });

  test("GET /api/quotations?quotation_type=<B type id> -- empty (no B data)", async () => {
    const r = await as(A.users.admin).get(`/api/quotations?quotation_type=${B.types.main._id}`);
    expect(r.status).toBe(200);
    const arr = Array.isArray(r.body) ? r.body : (r.body.data || []);
    expect(arr.length).toBe(0);
  });

  test("GET /api/quotations list -- no Tenant B quotations leak", async () => {
    const r = await as(A.users.admin).get("/api/quotations");
    expect(r.status).toBe(200);
    const arr = Array.isArray(r.body) ? r.body : (r.body.data || []);
    const bIds = B.quotations.map((q) => String(q._id));
    const leaked = arr.filter((q) => bIds.includes(String(q._id)));
    expect(leaked).toHaveLength(0);
  });

  test("GET /api/quotation-types -- Tenant B types not visible to Tenant A", async () => {
    const r = await as(A.users.admin).get("/api/quotation-types");
    expect(r.status).toBe(200);
    const slugs = r.body.map((t) => t.slug);
    expect(slugs).not.toContain("tenant-b-type");
  });

  test("PUT /api/quotation-types/:id (Tenant B type) -- 404, B type unchanged", async () => {
    const before = await QuotationType.findById(B.types.main._id).lean();
    const r = await as(A.users.admin).put(`/api/quotation-types/${B.types.main._id}`, { name: "Hacked" });
    expect(r.status).toBe(404);
    const after = await QuotationType.findById(B.types.main._id).lean();
    expect(after.name).toBe(before.name);
  });

  test("DELETE /api/quotation-types/:id (Tenant B type) -- 404, B type still exists", async () => {
    const r = await as(A.users.admin).del(`/api/quotation-types/${B.types.main._id}`);
    expect(r.status).toBe(404);
    expect(await QuotationType.findById(B.types.main._id)).not.toBeNull();
  });

  test("PUT /api/quotation-types/reorder with B ids -- B types untouched", async () => {
    const before = await QuotationType.findById(B.types.main._id).lean();
    await as(A.users.admin).put("/api/quotation-types/reorder", {
      items: [{ id: String(B.types.main._id), order: 999 }],
    });
    const after = await QuotationType.findById(B.types.main._id).lean();
    expect(after.order).toBe(before.order);
  });

  describe("approval endpoints: Tenant A token on Tenant B quotation", () => {
    beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
    afterAll(()  => setFeatures(A.tenantId, []));

    test("POST request-approval on Tenant B quotation -- 404", async () => {
      const r = await as(A.users.admin).post(`/api/quotations/${B.quotations[0]._id}/request-approval`);
      expect(r.status).toBe(404);
    });

    test("POST approve on Tenant B quotation -- 404", async () => {
      const r = await as(A.users.admin).post(`/api/quotations/${B.quotations[0]._id}/approve`, {});
      expect(r.status).toBe(404);
    });

    test("POST reject on Tenant B quotation -- 404", async () => {
      const r = await as(A.users.admin).post(`/api/quotations/${B.quotations[0]._id}/reject`, { comment: "x" });
      expect(r.status).toBe(404);
    });

    test("GET approval-history on Tenant B quotation -- 404", async () => {
      const r = await as(A.users.admin).get(`/api/quotations/${B.quotations[0]._id}/approval-history`);
      expect(r.status).toBe(404);
    });
  });

  // ── Mass-assignment: PUT with tenant_id = B must not move quota ────────────
  test("PUT tenant_id=B on Tenant A quota -- stays in Tenant A (mass-assignment guard)", async () => {
    const q  = await mkQ();
    const r  = await as(A.users.admin).put(`/api/quotations/${q._id}`, { tenant_id: String(B.tenantId) });
    const db = await Quotation.findById(q._id).lean();
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
    // Confirm B can't see it
    const bSee = await as(B.users.admin).get(`/api/quotations/${q._id}`);
    expect(bSee.status).toBe(404);
  });

  test("PUT tenant_id=B on Tenant A quotation type -- stays in Tenant A", async () => {
    const t  = await (async () => {
      const r = await as(A.users.admin).post("/api/quotation-types", {
        name: `IsoType-${Date.now()}`, format: "both",
      });
      return r.body;
    })();
    await as(A.users.admin).put(`/api/quotation-types/${t._id}`, {
      tenant_id: String(B.tenantId), name: t.name,
    });
    const db = await QuotationType.findById(t._id).lean();
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });
});

// =============================================================================
//  STATS CONSISTENCY
//  GET /api/quotations/stats values must match what GET /api/quotations returns
// =============================================================================
describe("stats consistency: /stats matches /list", () => {
  beforeAll(async () => {
    await setFeatures(A.tenantId, []);
    // Create a handful of this-month quotations for a fresh type
    const QuotationTypeMdl = require("../../models/QuotationType");
    const typeId = (await QuotationTypeMdl.create({
      name: `StatsType-${Date.now()}`, slug: `stats-type-${Date.now()}`, format: "both", order: 99, tenant_id: A.tenantId,
    }))._id;
    A._statsTypeId = typeId;
    const now = new Date();
    await Quotation.insertMany([
      { number: `QUO-ST1-${Date.now()}`, tenant_id: A.tenantId, quotation_type: typeId, total: 1000, date: now, created_by: A.users.admin.id, status: "accepted" },
      { number: `QUO-ST2-${Date.now()}`, tenant_id: A.tenantId, quotation_type: typeId, total: 2000, date: now, created_by: A.users.admin.id, status: "draft" },
      { number: `QUO-ST3-${Date.now()}`, tenant_id: A.tenantId, quotation_type: typeId, total: 500,  date: now, created_by: A.users.admin.id, status: "accepted" },
    ]);
  });

  test("stats this-month count and totalValue match list", async () => {
    const stats = (await as(A.users.admin).get(`/api/quotations/stats?quotation_type=${A._statsTypeId}`)).body;
    const list  = (await as(A.users.admin).get(`/api/quotations?quotation_type=${A._statsTypeId}&page=1&limit=500`)).body;
    const data  = Array.isArray(list) ? list : (list.data || []);

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthData  = data.filter((q) => new Date(q.date || q.createdAt) >= monthStart);

    expect(stats.totalThisMonth).toBe(monthData.length);
    const listTotal = monthData.reduce((s, q) => s + (q.total || 0), 0);
    expect(Math.abs(stats.totalValue - listTotal)).toBeLessThan(0.01);
    const acceptedInList = monthData.filter((q) => q.status === "accepted").length;
    expect(stats.acceptedThisMonth).toBe(acceptedInList);
  });
});

// =============================================================================
//  LINK INTEGRITY: edit/delete client -- quotation still loads
// =============================================================================
describe("link integrity: deleted client -- quotation still loads", () => {
  test("delete client; quotation.get still returns 200 (dangling ref)", async () => {
    const Client = require("../../models/Client");
    const tmpClient = await Client.create({ company: "TempCo", tenant_id: A.tenantId });
    const q = await mkQ({ client: String(tmpClient._id) });
    await Client.findByIdAndDelete(tmpClient._id);
    const r = await as(A.users.admin).get(`/api/quotations/${q._id}`);
    // Server should still return the quotation (client field will be null after populate)
    expect(r.status).toBe(200);
    expect(r.body._id).toBe(q._id);
    expect(r.body.client).toBeNull();
  });
});

// =============================================================================
//  APPROVAL PERMISSION: admin and approver allowed; others 403
// =============================================================================
describe("approval permission: hasCapability('Quotations','Approve')", () => {
  beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
  afterAll(()  => setFeatures(A.tenantId, []));

  test("admin can approve -- 200", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r = await as(A.users.admin).post(`/api/quotations/${q._id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.approval.status).toBe("approved");
  });

  test("approver can approve -- 200", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r = await as(A.users.approver).post(`/api/quotations/${q._id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.approval.status).toBe("approved");
  });

  test("maker (no Approve cap) cannot approve -- 403", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r = await as(A.users.maker).post(`/api/quotations/${q._id}/approve`, {});
    expect(r.status).toBe(403);
  });

  test("noPerm cannot approve -- 403", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r = await as(A.users.noPerm).post(`/api/quotations/${q._id}/approve`, {});
    expect(r.status).toBe(403);
  });

  test("admin and approver can GET /approvals/pending; maker and noPerm cannot", async () => {
    const [adm, appr, mkr, np] = await Promise.all([
      as(A.users.admin).get("/api/quotations/approvals/pending"),
      as(A.users.approver).get("/api/quotations/approvals/pending"),
      as(A.users.maker).get("/api/quotations/approvals/pending"),
      as(A.users.noPerm).get("/api/quotations/approvals/pending"),
    ]);
    expect(adm.status).toBe(200);
    expect(appr.status).toBe(200);
    expect(mkr.status).toBe(403);
    expect(np.status).toBe(403);
  });
});

// =============================================================================
//  HRMS BRANCH <-> quotationTypes link
// =============================================================================
describe("HRMS branch <-> quotationTypes link", () => {
  test("branch quotationTypes still contains the type id after listing", async () => {
    const HRMSBranch = require("../../hrms/models/hrms_branch_model");
    const br = await HRMSBranch.findById(A.branches[0]._id).lean();
    expect(br.quotationTypes.map(String)).toContain(String(A.types.trinetra._id));
  });

  test("deleting the type removes it from DB but branch still has the stale id (FINDING: no cascade)", async () => {
    // Create a temp type and link it to the branch
    const HRMSBranch = require("../../hrms/models/hrms_branch_model");
    const tmpType = await QuotationType.create({
      name: `HRMSLinkType-${Date.now()}`, slug: `hrms-link-${Date.now()}`,
      format: "both", order: 99, tenant_id: A.tenantId,
    });
    await HRMSBranch.findByIdAndUpdate(A.branches[0]._id, { $addToSet: { quotationTypes: tmpType._id } });

    await as(A.users.admin).del(`/api/quotation-types/${tmpType._id}`);
    expect(await QuotationType.findById(tmpType._id)).toBeNull();

    // Branch still holds the stale id
    const brAfter = await HRMSBranch.findById(A.branches[0]._id).lean();
    const ids = brAfter.quotationTypes.map(String);
    expect(ids).toContain(String(tmpType._id));
  });
});
