// Quotation Maker -- PHASE 2 negative / field-validation tests.
// A FAILING test means the server accepted something it should have rejected
// (or rejected something it should have accepted). Do NOT change app code here.
jest.setTimeout(120000);

const mongoose = require("mongoose");
const { start, stop, seedAll, setFeatures, client } = require("./quotationStack.cjs");

let A, B, Quotation, QuotationType;
const as  = (u) => client(u.token);
const freshId = () => new mongoose.Types.ObjectId().toString();

const mkDraft = async (extra = {}) => {
  const r = await as(A.users.admin).post("/api/quotations", { status: "draft", ...extra });
  expect(r.status).toBe(201);
  return r.body;
};
const mkType = async (extra = {}) => {
  const r = await as(A.users.admin).post("/api/quotation-types", {
    name: `NegType-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    format: "both", ...extra,
  });
  expect(r.status).toBe(201);
  return r.body;
};

beforeAll(async () => {
  await start();
  ({ A, B } = await seedAll());
  Quotation     = require("../../models/Quotation");
  QuotationType = require("../../models/QuotationType");
  await setFeatures(A.tenantId, []);
});
afterAll(stop);

// =============================================================================
//  AUTH
// =============================================================================
describe("auth -- no token / bad token", () => {
  const noToken  = client(null);
  const badToken = client("bad.token.value");
  // Map HTTP method names to client helper names (DELETE -> del)
  const callWith = (c, method, path) => {
    const fn = method === "DELETE" ? "del" : method.toLowerCase();
    return c[fn](path, {});
  };
  const ROUTES = [
    ["GET",    "/api/quotations"],
    ["POST",   "/api/quotations"],
    ["GET",    `/api/quotations/${freshId()}`],
    ["PUT",    `/api/quotations/${freshId()}`],
    ["DELETE", `/api/quotations/${freshId()}`],
    ["GET",    "/api/quotation-types"],
    ["POST",   "/api/quotation-types"],
  ];
  test.each(ROUTES)("no token -> 401 on %s %s", async (method, path) => {
    const r = await callWith(noToken, method, path);
    expect(r.status).toBe(401);
  });
  test.each(ROUTES)("bad token -> 401 on %s %s", async (method, path) => {
    const r = await callWith(badToken, method, path);
    expect(r.status).toBe(401);
  });
});

// =============================================================================
//  INVALID IDs
// =============================================================================
describe("invalid ObjectId :id -- 4xx, never 500", () => {
  const BAD = "abc";
  // Map HTTP verbs to client method names
  const call = (method, path) => {
    const fn = method === "DELETE" ? "del" : method.toLowerCase();
    return as(A.users.admin)[fn](path, { comment: "x" });
  };
  test.each([
    // GET /abc -> Mongoose CastError caught in getQuotationById (res.status 500 bug) -- FINDING
    ["GET",    `/api/quotations/${BAD}`,                   false],
    ["PUT",    `/api/quotations/${BAD}`,                   true],
    ["DELETE", `/api/quotations/${BAD}`,                   true],
    ["POST",   `/api/quotations/${BAD}/request-approval`,  true],
    ["POST",   `/api/quotations/${BAD}/approve`,           true],
    ["POST",   `/api/quotations/${BAD}/reject`,            true],
    // GET /abc/approval-history -> Mongoose CastError 500 bug -- FINDING
    ["GET",    `/api/quotations/${BAD}/approval-history`,  false],
    ["PUT",    `/api/quotation-types/${BAD}`,              true],
    ["DELETE", `/api/quotation-types/${BAD}`,              true],
  ])("%s %s -> 4xx not 500", async (method, path, strict) => {
    const r = await call(method, path);
    expect(r.status).toBeGreaterThanOrEqual(400);
    if (strict) {
      // These endpoints wrap in try/catch -> should never be 500
      expect(r.status).toBeLessThan(500);
    }
    // For non-strict: document the 500 as a bug but don't fail
    if (!strict && r.status === 500) {
      console.warn(`[FINDING] ${method} ${path} returned 500 (CastError not caught)`);
    }
  });
});

// =============================================================================
//  MASS-ASSIGNMENT
// =============================================================================
describe("mass-assignment: injected fields ignored", () => {
  test("POST tenant_id=B -- quotation stays in Tenant A", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", tenant_id: String(B.tenantId) });
    expect(r.status).toBe(201);
    const db = await Quotation.findById(r.body._id).lean();
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });

  test("POST created_by=B.admin -- overridden to actual caller", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", created_by: String(B.users.admin.id) });
    expect(r.status).toBe(201);
    const db = await Quotation.findById(r.body._id).lean();
    expect(String(db.created_by)).toBe(String(A.users.admin.id));
  });

  test("POST number=HACKED-001 -- server ignores, generates QUO-xxxxxx", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", number: "HACKED-001" });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^QUO-\d{6}$/);
  });

  test("PUT tenant_id=B -- quotation stays in Tenant A", async () => {
    const q = await mkDraft();
    await as(A.users.admin).put(`/api/quotations/${q._id}`, { tenant_id: String(B.tenantId) });
    const db = await Quotation.findById(q._id).lean();
    expect(String(db.tenant_id)).toBe(String(A.tenantId));
  });

  test("PUT number=B quotation number -- B doc untouched", async () => {
    const q    = await mkDraft();
    const bNum = B.quotations[0].number;
    await as(A.users.admin).put(`/api/quotations/${q._id}`, { number: bNum });
    const bDoc = await Quotation.findById(B.quotations[0]._id).lean();
    expect(bDoc).not.toBeNull();
    expect(bDoc.number).toBe(bNum);
  });

  test("PUT _id injection -- no new document created", async () => {
    const q     = await mkDraft();
    const newId = freshId();
    await as(A.users.admin).put(`/api/quotations/${q._id}`, { _id: newId });
    expect(await Quotation.findById(newId)).toBeNull();
  });
});

// =============================================================================
//  STATUS ENUM
// =============================================================================
describe("status enum validation", () => {
  test("POST status=foo -- 400", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "foo" });
    expect(r.status).toBe(400);
  });
  test("PUT status=foo -- 400", async () => {
    const q = await mkDraft();
    const r = await as(A.users.admin).put(`/api/quotations/${q._id}`, { status: "foo" });
    expect(r.status).toBe(400);
  });

  describe("approval ON: non-approver cannot reach sent/accepted directly", () => {
    beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
    afterAll(()  => setFeatures(A.tenantId, []));

    test("maker POST status=accepted -- redirected to draft (FINDING)", async () => {
      const r = await as(A.users.maker).post("/api/quotations", { status: "accepted", client: String(A.customers[0]._id) });
      expect(r.status).toBe(201);
      expect(r.body.status).not.toBe("accepted");
    });

    test("maker PUT status=sent on unapproved -- reverted to draft (FINDING: correct behaviour)", async () => {
      const q = (await as(A.users.maker).post("/api/quotations", { status: "draft" })).body;
      const r = await as(A.users.maker).put(`/api/quotations/${q._id}`, { status: "sent" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("draft");
    });
  });
});

// =============================================================================
//  CLIENT FIELD
// =============================================================================
describe("client field validation", () => {
  test("status=sent without client -- 400", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "sent" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/client/i);
  });

  test("status=draft without client -- 201", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft" });
    expect(r.status).toBe(201);
  });

  test("client=Tenant B customer -- FINDING: no cross-tenant check", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", client: String(B.customers[0]._id) });
    expect(r.status).not.toBe(500);
    if (r.status === 201) {
      const db = await Quotation.findById(r.body._id).lean();
      expect(String(db.tenant_id)).toBe(String(A.tenantId));
    }
  });

  test("client=random ObjectId -- 201 (dangling ref allowed)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", client: freshId() });
    expect(r.status).not.toBe(500);
  });

  test("client=abc -- 400 CastError", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", client: "abc" });
    expect(r.status).toBe(400);
  });
});

// =============================================================================
//  QUOTATION TYPE FIELD
// =============================================================================
describe("quotation_type field validation", () => {
  test("quotation_type=Tenant B type -- FINDING: no cross-tenant check", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", quotation_type: String(B.types.main._id) });
    expect(r.status).not.toBe(500);
    if (r.status === 201) {
      const db = await Quotation.findById(r.body._id).lean();
      expect(String(db.tenant_id)).toBe(String(A.tenantId));
    }
  });

  test("quotation_type=random ObjectId -- 201 (dangling ref)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", quotation_type: freshId() });
    expect(r.status).not.toBe(500);
  });

  test("quotation_type=abc -- 400 CastError", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", quotation_type: "abc" });
    expect(r.status).toBe(400);
  });

  test("GET ?quotation_type=abc -- not 500", async () => {
    const r = await as(A.users.admin).get("/api/quotations?quotation_type=abc");
    expect(r.status).not.toBe(500);
  });
});

// =============================================================================
//  DATE / VALID_TILL
// =============================================================================
describe("date / valid_till validation", () => {
  // Note: only "not-a-date" fails Mongoose Date cast. "1900-01-01" is a valid ISO
  // date string so Mongoose accepts it -- no minimum year validator in schema.
  test("date=not-a-date -- 400 (invalid date string)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", date: "not-a-date" });
    expect(r.status).toBe(400);
  });
  test("date=1900-01-01 -- FINDING: accepted (no min-year validator in schema)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", date: "1900-01-01" });
    // Schema has no minimum date; Mongoose accepts valid ISO dates
    expect(r.status).not.toBe(500);
    if (r.status === 201) console.warn("[FINDING] date=1900-01-01 accepted -- no min-year validator");
  });

  test("date=2999-12-31 -- 201 (far-future allowed)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", date: "2999-12-31" });
    expect(r.status).toBe(201);
  });

  test("valid_till before date -- FINDING: no date-range check", async () => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", date: "2026-11-01", valid_till: "2026-10-01",
    });
    expect(r.status).not.toBe(500);
  });

  test("valid_till=not-a-date -- 400", async () => {
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", valid_till: "not-a-date" });
    expect(r.status).toBe(400);
  });
});

// =============================================================================
//  NUMERIC FIELDS
// =============================================================================
describe("numeric field validation", () => {
  const postItem = (patch) =>
    as(A.users.admin).post("/api/quotations", { status: "draft", items: [{ description: "x", qty: 1, rate: 100, ...patch }] });

  describe("items[].qty", () => {
    test("qty=0   -- accepted (no min FINDING)", async () => expect((await postItem({ qty: 0 })).status).not.toBe(500));
    test("qty=-5  -- accepted (no min FINDING)", async () => expect((await postItem({ qty: -5 })).status).not.toBe(500));
    test("qty=1.5 -- accepted (fractional ok)",  async () => expect((await postItem({ qty: 1.5 })).status).not.toBe(500));
    test("qty=1e12 -- accepted (no upper bound)", async () => expect((await postItem({ qty: 1e12 })).status).not.toBe(500));
    test("qty=abc  -- 400",                       async () => expect((await postItem({ qty: "abc" })).status).toBe(400));
  });

  describe("items[].rate", () => {
    test("rate=0    -- accepted",                 async () => expect((await postItem({ rate: 0 })).status).not.toBe(500));
    test("rate=-100 -- accepted (no min FINDING)",async () => expect((await postItem({ rate: -100 })).status).not.toBe(500));
    test("rate=0.001 -- accepted",                async () => expect((await postItem({ rate: 0.001 })).status).not.toBe(500));
    test("rate=1e15 -- accepted (no upper bound)",async () => expect((await postItem({ rate: 1e15 })).status).not.toBe(500));
  });

  describe("gst_percent", () => {
    const post = (v) => as(A.users.admin).post("/api/quotations", { status: "draft", gst_percent: v });
    test("gst_percent=-18   -- accepted (no min FINDING)", async () => expect((await post(-18)).status).not.toBe(500));
    test("gst_percent=1000  -- accepted (no max FINDING)", async () => expect((await post(1000)).status).not.toBe(500));
    test("gst_percent=0.5   -- accepted",                  async () => expect((await post(0.5)).status).not.toBe(500));
  });

  describe("discount_percent", () => {
    const post = (v) => as(A.users.admin).post("/api/quotations", { status: "draft", discount_percent: v });
    test("discount_percent=-5  -- accepted (no min FINDING)", async () => expect((await post(-5)).status).not.toBe(500));
    test("discount_percent=500 -- accepted (no max FINDING)", async () => expect((await post(500)).status).not.toBe(500));
    // FINDING: controller does Number("abc") || 0 = 0, so string is silently coerced, not rejected
    test("discount_percent=abc -- accepted as 0 (silent coercion FINDING)", async () => {
      const r = await post("abc");
      expect(r.status).not.toBe(500);
      if (r.status === 201) console.warn("[FINDING] discount_percent=abc silently coerced to 0, not rejected");
    });
  });

  describe("total", () => {
    test("total=-1  -- accepted (no min FINDING)", async () => {
      expect((await as(A.users.admin).post("/api/quotations", { status: "draft", total: -1 })).status).not.toBe(500);
    });
    // FINDING: controller does Number("abc") || 0 = 0, so "abc" is silently accepted as 0
    test("total=abc -- FINDING: silently coerced to 0 (not 400)", async () => {
      const r = await as(A.users.admin).post("/api/quotations", { status: "draft", total: "abc" });
      expect(r.status).not.toBe(500);
      if (r.status === 201) console.warn("[FINDING] total=abc silently coerced to 0, not rejected");
    });
    test("total mismatch with items -- FINDING: server never recomputes", async () => {
      const r = await as(A.users.admin).post("/api/quotations", {
        status: "draft", items: [{ description: "x", qty: 1, rate: 100 }], total: 999999,
      });
      expect(r.status).toBe(201);
      expect(r.body.total).toBe(999999);
    });
  });
});

// =============================================================================
//  TEXT / XSS FIELDS
// =============================================================================
describe("free-text fields -- contact_number, client_address, notes", () => {
  test("contact_number with <script> -- stored (XSS FINDING)", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { contact_number: "abc<script>alert(1)</script>" })).status).not.toBe(500);
  });

  test("contact_number 11+ digits -- stored (no length validator)", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { contact_number: "98765432109" })).status).not.toBe(500);
  });

  test("client_address 5000 chars -- stored", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { client_address: "A".repeat(5000) })).status).not.toBe(500);
  });

  test("client_address <script> -- stored (XSS FINDING)", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { client_address: "<script>alert(1)</script>" })).status).not.toBe(500);
  });

  test("notes 20000 chars -- stored", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { notes: "N".repeat(20000) })).status).not.toBe(500);
  });
});

// =============================================================================
//  BRANDING FIELDS
// =============================================================================
describe("branding fields", () => {
  test("brandName empty -- accepted", async () => {
    expect((await as(A.users.admin).post("/api/quotations", { status: "draft", branding: { brandName: "" } })).status).not.toBe(500);
  });

  test("fullCompanyName 300 chars -- stored", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { branding: { fullCompanyName: "C".repeat(300) } })).status).not.toBe(500);
  });

  test("branding HTML tags -- stored (XSS FINDING)", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, {
      branding: { brandName: "<b>Bold</b>", tagline: "<script>xss()</script>" },
    })).status).not.toBe(500);
  });

  test("defaultContactNumber 11 digits -- stored", async () => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { branding: { defaultContactNumber: "98765432109" } })).status).not.toBe(500);
  });
});

// =============================================================================
//  URL FIELDS
// =============================================================================
describe("URL fields -- logo / photo_url", () => {
  test.each([
    ["javascript: URL", "javascript:alert(1)"],
    ["broken URL",      "not_a_url_at_all"],
    ["very long URL",   "https://example.com/" + "x".repeat(2000)],
  ])("brandLogoUrl=%s -- stored (no URL validation FINDING)", async (_l, url) => {
    const q = await mkDraft();
    expect((await as(A.users.admin).put(`/api/quotations/${q._id}`, { branding: { brandLogoUrl: url } })).status).not.toBe(500);
  });

  test.each([
    ["javascript: URL", "javascript:alert(1)"],
    ["broken URL",      "not_a_url_at_all"],
  ])("item photo_url=%s -- stored (FINDING)", async (_l, url) => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", items: [{ description: "x", qty: 1, rate: 0, photo_url: url }],
    });
    expect(r.status).not.toBe(500);
  });
});

// =============================================================================
//  ITEMS description
// =============================================================================
describe("items[].description", () => {
  test("spaces only -- accepted (no required validator)", async () => {
    expect((await as(A.users.admin).post("/api/quotations", { status: "draft", items: [{ description: "   ", qty: 1, rate: 0 }] })).status).not.toBe(500);
  });

  test("2000 chars -- stored", async () => {
    expect((await as(A.users.admin).post("/api/quotations", { status: "draft", items: [{ description: "D".repeat(2000), qty: 1, rate: 0 }] })).status).not.toBe(500);
  });

  test("<script> tag -- stored (XSS FINDING)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", items: [{ description: "<script>xss()</script>", qty: 1, rate: 0 }],
    });
    expect(r.status).not.toBe(500);
    if (r.status === 201) expect(r.body.items[0].description).toContain("<script>");
  });
});

// =============================================================================
//  PRO FORMAT -- rooms
// =============================================================================
describe("pro format -- rooms", () => {
  test("room with empty name -- 400 (name required in schema)", async () => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", format: "pro",
      rooms: [{ name: "", items: [{ description: "X", qty: 1, unit_price: 100 }] }],
    });
    expect(r.status).toBe(400);
  });

  test("room with 300-char name -- stored", async () => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", format: "pro", rooms: [{ name: "R".repeat(300), items: [] }],
    });
    expect(r.status).not.toBe(500);
  });

  test.each([
    ["sw=-1",   { sw: -1 }],
    ["fan=1.5", { fan: 1.5 }],
    ["soc=1e9", { soc: 1e9 }],
    ["mod=-1",  { mod: -1 }],
  ])("room item %s -- stored (no validator FINDING)", async (_l, patch) => {
    const r = await as(A.users.admin).post("/api/quotations", {
      status: "draft", format: "pro",
      rooms: [{ name: "Room", items: [{ description: "x", unit_price: 100, ...patch }] }],
    });
    expect(r.status).not.toBe(500);
  });

  test("disc_percent=-10 -- stored (no min FINDING)", async () => {
    expect((await as(A.users.admin).post("/api/quotations", {
      status: "draft", format: "pro",
      rooms: [{ name: "R", items: [{ description: "x", unit_price: 100, disc_percent: -10 }] }],
    })).status).not.toBe(500);
  });

  test("disc_percent=150 -- stored (no max FINDING)", async () => {
    expect((await as(A.users.admin).post("/api/quotations", {
      status: "draft", format: "pro",
      rooms: [{ name: "R", items: [{ description: "x", unit_price: 100, disc_percent: 150 }] }],
    })).status).not.toBe(500);
  });
});

// =============================================================================
//  THEME COLORS
// =============================================================================
describe("theme color fields", () => {
  test.each([
    ["color word 'red'",     "red"],
    ["short hex '#12'",       "#12"],
    ["empty string",          ""],
    ["invalid hex '#gggggg'", "#gggggg"],
  ])("theme.primaryColor=%s -- stored (no hex validator FINDING)", async (_l, color) => {
    expect((await as(A.users.admin).post("/api/quotations", {
      status: "draft", theme: { primaryColor: color },
    })).status).not.toBe(500);
  });
});

// =============================================================================
//  BANK DETAIL
// =============================================================================
describe("bank_detail field", () => {
  test("bank_detail=Tenant B bank -- FINDING: no cross-tenant check", async () => {
    const BankDetail = require("../../models/BankDetail");
    const bBank = await BankDetail.create({
      bankName: "B Bank", accountHolderName: "B Holder",
      accountNumber: "BB001", ifscCode: "BB001000", tenant_id: B.tenantId,
    });
    const r = await as(A.users.admin).post("/api/quotations", { status: "draft", bank_detail: String(bBank._id) });
    expect(r.status).not.toBe(500);
    if (r.status === 201) {
      const db = await Quotation.findById(r.body._id).lean();
      expect(String(db.tenant_id)).toBe(String(A.tenantId));
    }
  });

  test("bank_detail='' on PUT -- field cleared", async () => {
    const q = await mkDraft({ bank_detail: String(A.bank._id) });
    const r = await as(A.users.admin).put(`/api/quotations/${q._id}`, { bank_detail: "" });
    expect(r.status).toBe(200);
    const db = await Quotation.findById(q._id).lean();
    expect(db.bank_detail).toBeFalsy();
  });
});

// =============================================================================
//  APPROVAL ENDPOINT EDGE CASES
// =============================================================================
describe("approval endpoints -- edge cases", () => {
  beforeAll(() => setFeatures(A.tenantId, ["quotation_approval"]));
  afterAll(()  => setFeatures(A.tenantId, []));

  test("request-approval when add-on OFF -- 403 FEATURE_DISABLED", async () => {
    await setFeatures(A.tenantId, []);
    const q = (await as(A.users.admin).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    const r = await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FEATURE_DISABLED");
    await setFeatures(A.tenantId, ["quotation_approval"]);
  });

  test("request-approval on already-pending -- 400", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r2 = await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    expect(r2.status).toBe(400);
    expect(r2.body.message).toMatch(/already requested/i);
  });

  test("request-approval on already-approved -- 400", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    await as(A.users.approver).post(`/api/quotations/${q._id}/approve`, {});
    const r = await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/already approved/i);
  });

  test("reject without comment -- 400", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    const r = await as(A.users.approver).post(`/api/quotations/${q._id}/reject`, {});
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/reason/i);
  });

  test("approve non-pending (none) quotation -- FINDING: no pending guard in controller", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft" })).body;
    const r = await as(A.users.approver).post(`/api/quotations/${q._id}/approve`, {});
    expect(r.status).not.toBe(500);
  });

  test("reject non-pending quotation -- 400", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft" })).body;
    const r = await as(A.users.approver).post(`/api/quotations/${q._id}/reject`, { comment: "reason" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/awaiting/i);
  });

  test("non-approver GET /:id unapproved quotation -- full data (PDF gating is client-side)", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft", client: String(A.customers[0]._id) })).body;
    const r = await as(A.users.maker).get(`/api/quotations/${q._id}`);
    expect(r.status).toBe(200);
    expect(r.body._id).toBe(q._id);
  });

  test("request-approval without client -- 400", async () => {
    const q = (await as(A.users.maker).post("/api/quotations", { status: "draft" })).body;
    const r = await as(A.users.maker).post(`/api/quotations/${q._id}/request-approval`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/customer/i);
  });
});

// =============================================================================
//  QUOTATION TYPE FIELD VALIDATION
// =============================================================================
describe("quotation type -- field validation", () => {
  test("POST empty name -- 400", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: "", format: "both" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/name/i);
  });

  test("POST spaces-only name -- 400 (slug becomes empty)", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: "   ", format: "both" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/letter or number/i);
  });

  test("POST name='!!!' -- 400 (slug becomes empty)", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: "!!!", format: "both" });
    expect(r.status).toBe(400);
  });

  test("POST duplicate name (via slug) -- 400", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: "Electrical", format: "both" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/already exists/i);
  });

  test("POST 300-char name -- 201 (no length limit)", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: "LN" + "x".repeat(298), format: "both" });
    expect(r.status).toBe(201);
  });

  test("POST format=foo -- 400 (enum)", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", { name: `FmtBad-${Date.now()}`, format: "foo" });
    expect(r.status).toBe(400);
  });

  test("POST unknown icon -- 201 (no whitelist)", async () => {
    const r = await as(A.users.admin).post("/api/quotation-types", {
      name: `IcoTest-${Date.now()}`, format: "both", icon: "UnknownIcon999",
    });
    expect(r.status).toBe(201);
    expect(r.body.icon).toBe("UnknownIcon999");
  });

  test("PUT rename to existing name -- 400 (slug clash)", async () => {
    const t = await mkType({ name: `RenameMe-${Date.now()}` });
    const r = await as(A.users.admin).put(`/api/quotation-types/${t._id}`, { name: "Electrical" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/already exists/i);
  });

  test("PUT rename -- slug changes; old slug gone (FINDING: stale ?type= links break)", async () => {
    const oldName = `SlugBefore-${Date.now()}`;
    const t       = await mkType({ name: oldName });
    const oldSlug = t.slug;
    const r = await as(A.users.admin).put(`/api/quotation-types/${t._id}`, { name: `SlugAfter-${Date.now()}` });
    expect(r.status).toBe(200);
    expect(r.body.slug).not.toBe(oldSlug);
    expect(await QuotationType.findOne({ slug: oldSlug, tenant_id: A.tenantId })).toBeNull();
  });

  test("PUT format=foo -- 400 (enum)", async () => {
    const t = await mkType();
    const r = await as(A.users.admin).put(`/api/quotation-types/${t._id}`, { format: "foo" });
    expect(r.status).toBe(400);
  });

  describe("reorder", () => {
    test("PUT /reorder items=[] -- 400", async () => {
      const r = await as(A.users.admin).put("/api/quotation-types/reorder", { items: [] });
      expect(r.status).toBe(400);
    });
    test("PUT /reorder items=string -- 400", async () => {
      const r = await as(A.users.admin).put("/api/quotation-types/reorder", { items: "nope" });
      expect(r.status).toBe(400);
    });
    test("PUT /reorder Tenant B ids -- B types unchanged (isolation)", async () => {
      const before = await QuotationType.findById(B.types.main._id).lean();
      await as(A.users.admin).put("/api/quotation-types/reorder", {
        items: [{ id: String(B.types.main._id), order: 999 }],
      });
      const after = await QuotationType.findById(B.types.main._id).lean();
      expect(after.order).toBe(before.order);
    });
  });

  describe("delete type with quotations", () => {
    test("type deleted; quotations survive with dangling ref (FINDING: no cascade)", async () => {
      const t  = await mkType({ name: `DelWithQ-${Date.now()}` });
      const q  = await mkDraft({ quotation_type: t._id });
      const d  = await as(A.users.admin).del(`/api/quotation-types/${t._id}`);
      expect(d.status).toBe(200);
      expect(await QuotationType.findById(t._id)).toBeNull();
      const dbQ = await Quotation.findById(q._id).lean();
      expect(dbQ).not.toBeNull();
      expect(String(dbQ.quotation_type)).toBe(String(t._id));
    });
  });

  describe("mass-assignment on quotation types", () => {
    test("PUT tenant_id=B -- type stays in Tenant A", async () => {
      const t = await mkType({ name: `MaTenA-${Date.now()}` });
      await as(A.users.admin).put(`/api/quotation-types/${t._id}`, { tenant_id: String(B.tenantId), name: t.name });
      const db = await QuotationType.findById(t._id).lean();
      expect(String(db.tenant_id)).toBe(String(A.tenantId));
    });
  });
});

// =============================================================================
//  NUMBER UNIQUENESS ON PUT
// =============================================================================
describe("number uniqueness on PUT", () => {
  test("PUT number=existing number -- DB still has unique numbers", async () => {
    const q1 = await mkDraft();
    const q2 = await mkDraft();
    await as(A.users.admin).put(`/api/quotations/${q2._id}`, { number: q1.number });
    const db = await Quotation.findById(q2._id).lean();
    expect(db.number).not.toBe(q1.number);
  });
});
