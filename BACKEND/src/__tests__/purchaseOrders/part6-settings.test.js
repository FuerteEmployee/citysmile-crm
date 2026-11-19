// PART 6 — PO Settings (GET/PUT /api/purchase-orders/settings).
// "[BUG]" / "[RECORD]" / "[QUESTION]" tests assert the CURRENT behaviour.
jest.mock("../../services/whatsapp_service", () => require("./poStack.cjs").waMock);
jest.mock("../../hrms/utils/cloudinary_config", () => require("./poStack.cjs").cloudinaryMockFactory());

const S = require("./poStack.cjs");

jest.setTimeout(240000);
const P = S.PO_PATH;
const SET = `${P}/settings`;
const year = new Date().getFullYear();
const fy = S.fyNow();
let A, B;
const PoSettings = () => require("../../models/PoSettings");
const PurchaseOrder = () => require("../../models/PurchaseOrder");
const adm = () => A.users.admin.api;
const get = async () => (await adm().get(SET)).body;

beforeAll(async () => {
  await S.startStack();
  A = await S.seedTenant("A");
  B = await S.seedTenant("B", { settings: false }); // 6.1 checks the defaults the app creates on first read
  // Extra divisions for the division / prefix tests below, put straight into
  // A's in-memory settings so those tests don't depend on the add tests.
  await PoSettings().updateOne(
    { tenant_id: A.tenantId },
    { $push: { divisions: { $each: [
      { key: "brady-co", name: "Brady & Co.", purchase_prefix: "BC-PPO", sales_prefix: "BC-SPO", active: true },
      { key: "my-key", name: "Other Name", purchase_prefix: "MK-P", sales_prefix: "MK-S", active: true },
      { key: "unused", name: "Unused", purchase_prefix: "U-P", sales_prefix: "U-S", active: true },
    ] } } }
  );
  process.env.PURCHASE_ORDERS_TENANT_IDS = `${A.tenantId},${B.tenantId}`;
});

afterAll(async () => {
  console.log("[guard] PART6", JSON.stringify(S.guardReport()), "recorders", JSON.stringify({ net: S.rec.blockedNetwork, wa: S.rec.whatsapp.length, cloud: S.rec.cloudinary.length }));
  expect(S.rec.blockedNetwork).toEqual([]);
  expect(S.rec.whatsapp).toEqual([]);
  expect(S.rec.cloudinary).toEqual([]);
  await S.stopStack();
});

describe("6.1 UNIT", () => {
  test("GET creates the settings document with the defaults on first read (a write)", async () => {
    expect(await PoSettings().countDocuments({ tenant_id: B.tenantId })).toBe(0);
    const r = await B.users.viewer.api.get(SET);
    expect(r.status).toBe(200);
    expect(await PoSettings().countDocuments({ tenant_id: B.tenantId })).toBe(1);
    // Default divisions: ONLY Brady (Sparkling is no longer a default; tests that
    // need it get it from the poStack seed).
    expect(r.body.divisions).toEqual([{ key: "brady", name: "Brady", purchase_prefix: "PPO", sales_prefix: "SPO", active: true }]);
    const saved = await PoSettings().findOne({ tenant_id: B.tenantId }).lean();
    expect(saved.divisions.map((d) => d.key)).toEqual(["brady"]);
    // Round 28 (R6): the Purchase PO has the floor (End User Price, price only
    // up); the margin minimum 13 % is shown to the approver.
    expect(r.body.rules).toEqual({
      purchase: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: 13, allow_below_list: false, price_floor: true },
      sales: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false, price_floor: true },
    });
    expect(r.body.counters).toBeUndefined();
    expect(r.body.format_history).toBeUndefined();
    expect(r.body.format_versions).toEqual([{ version: 1, saved_at: expect.any(String) }]);
  });

  test("10 parallel first reads create exactly one settings document", async () => {
    const C = await S.seedTenant("C2", { settings: false });
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${C.tenantId}`;
    const rs = await Promise.all(Array.from({ length: 10 }, () => C.users.admin.api.get(SET)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await PoSettings().countDocuments({ tenant_id: C.tenantId })).toBe(1);
  });

  test("cleanRule: '' / null = off; numbers 0..100 kept", async () => {
    const r = await adm().put(SET, { rules: { purchase: { list_price_field: "master_price", max_discount_pct: "", min_margin_pct: "0", allow_below_list: true }, sales: { list_price_field: "distributor_price", max_discount_pct: 100, min_margin_pct: null, allow_below_list: false } } });
    expect(r.status).toBe(200);
    // G1: price_floor not sent -> keeps the saved value (now on for both, R6)
    expect(r.body.rules).toEqual({
      purchase: { list_price_field: "master_price", max_discount_pct: null, min_margin_pct: 0, allow_below_list: true, price_floor: true },
      sales: { list_price_field: "distributor_price", max_discount_pct: 100, min_margin_pct: null, allow_below_list: false, price_floor: true },
    });
    await adm().put(SET, { rules: { purchase: { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true }, sales: { list_price_field: "end_customer_price", max_discount_pct: null, min_margin_pct: null, allow_below_list: false } } });
  });

  test("[BUG] allow_below_list 'false' (string) is saved as true (only boolean false switches it off)", async () => {
    const r = await adm().put(SET, { rules: { sales: { list_price_field: "end_customer_price", allow_below_list: "false" } } });
    expect(r.body.rules.sales.allow_below_list).toBe(true);
    await adm().put(SET, { rules: { sales: { list_price_field: "end_customer_price", allow_below_list: false } } });
  });

  // Brady only: a division whose cleaned key isn't saved yet is refused, so
  // key cleaning is checked by sending the EXISTING divisions in messy forms.
  test("division key cleaning: 'Brady & Co.' -> 'brady-co'; explicit key wins over name; values trimmed", async () => {
    const cur = await get();
    const messy = cur.divisions.map((d) => {
      if (d.key === "brady-co") return { name: "Brady & Co.", purchase_prefix: " BC-PPO ", sales_prefix: "BC-SPO" }; // no key: made from the name
      if (d.key === "my-key") return { key: "  My KEY!! ", name: "Renamed Other", purchase_prefix: "MK-P", sales_prefix: "MK-S" }; // key wins over the name
      return d;
    });
    const r = await adm().put(SET, { divisions: messy });
    expect(r.status).toBe(200);
    expect(r.body.divisions.filter((d) => ["brady-co", "my-key"].includes(d.key))).toEqual([
      { key: "brady-co", name: "Brady & Co.", purchase_prefix: "BC-PPO", sales_prefix: "BC-SPO", active: true },
      { key: "my-key", name: "Renamed Other", purchase_prefix: "MK-P", sales_prefix: "MK-S", active: true },
    ]);
    expect(r.body.divisions.map((d) => d.key)).toEqual(cur.divisions.map((d) => d.key));
    await adm().put(SET, { divisions: cur.divisions });
  });

  test("adding divisions via PUT -> 200 and saved: key cleaned from the name ('Brady & Co. Ltd' -> 'brady-co-ltd'), explicit key wins", async () => {
    const cur = await get();
    const r = await adm().put(SET, { divisions: [...cur.divisions,
      { name: " Brady & Co. Ltd ", purchase_prefix: " BCL-P ", sales_prefix: "BCL-S" },
      { key: "  Another KEY!! ", name: "Brady", purchase_prefix: "AN-P", sales_prefix: "AN-S" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.divisions.slice(cur.divisions.length)).toEqual([
      { key: "brady-co-ltd", name: "Brady & Co. Ltd", purchase_prefix: "BCL-P", sales_prefix: "BCL-S", active: true },
      { key: "another-key", name: "Brady", purchase_prefix: "AN-P", sales_prefix: "AN-S", active: true },
    ]);
    const saved = await PoSettings().findOne({ tenant_id: A.tenantId }).lean();
    expect(saved.divisions.map((d) => d.key)).toEqual([...cur.divisions.map((d) => d.key), "brady-co-ltd", "another-key"]);
    // back to the starting list (both are unused, so removing them is allowed)
    expect((await adm().put(SET, { divisions: cur.divisions })).status).toBe(200);
    expect((await get()).divisions).toEqual(cur.divisions);
  });

  test("format version bumps only when the format changes", async () => {
    const cur = await get();
    const same = await adm().put(SET, { format: cur.format });
    expect(same.body.format_version).toBe(cur.format_version);
    const changed = await adm().put(SET, { format: { ...cur.format, title_purchase: "PURCHASE ORDER" } });
    expect(changed.body.format_version).toBe(cur.format_version + 1);
    expect(changed.body.format_versions).toHaveLength(cur.format_versions.length + 1);
  });
});

describe("6.2 POSITIVE", () => {
  test("an extra (older) division -> PO in it gets its own <prefix>-<year>-0001", async () => {
    const r = await A.users.maker.api.post(P, { type: "purchase", division: "brady-co", items: [S.line(A.items.I1, 1)] });
    expect(r.status).toBe(201);
    expect(r.body.po_number).toBe(`BC-PPO/01/${fy}`);
  });

  // R4: approval is always required now, so the rule's effect is checked on
  // the reasons shown to the approver (margin 37.5 %: fine at 13, low at 40).
  test("rule change affects NEW POs only; old PO keeps its rule_snapshot", async () => {
    const good = await require("../../models/PoItem").create({ name: "Margin 37.5", item_code: "M375", tenant_id: A.tenantId, master_price: 100, end_customer_price: 160 });
    const old = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(good, 1)] })).body;
    expect(old.approval).toMatchObject({ required: true, reasons: [] });
    const cur = await get();
    await adm().put(SET, { rules: { purchase: { ...cur.rules.purchase, min_margin_pct: 40 } } });
    const neu = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(good, 1)] })).body;
    expect(neu.approval.reasons.join(" ")).toMatch(/below the 40% minimum/);
    expect(neu.rule_snapshot.min_margin_pct).toBe(40);
    const oldNow = await PurchaseOrder().findById(old._id).lean();
    expect(oldNow.rule_snapshot.min_margin_pct).toBe(13);
    expect(oldNow.approval.reasons).toEqual([]);
    await adm().put(SET, { rules: { purchase: cur.rules.purchase } });
  });

  test("supplier edit prints on NEW POs only (snapshot)", async () => {
    const old = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).body;
    const r = await adm().put(SET, { supplier: { name: " Brady India ", gstin: "27AAACB1234C1Z1", phone: "022-12345678", whatsapp: "9000000001", email: "po@brady.test", address: "Mumbai", state: "Maharashtra" } });
    expect(r.body.supplier).toEqual({ name: "Brady India", gstin: "27AAACB1234C1Z1", phone: "022-12345678", whatsapp: "9000000001", email: "po@brady.test", address: "Mumbai", state: "Maharashtra" });
    const neu = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).body;
    expect(neu.supplier.name).toBe("Brady India");
    expect((await A.users.maker.api.get(`${P}/${old._id}`)).body.supplier.name).toBe("Brady");
  });

  test("WhatsApp template + params saved", async () => {
    const r = await adm().put(SET, { whatsapp: { template_name: " po_document ", template_language: "en_US", body_params: ["{{po_number}}", 5] } });
    expect(r.body.whatsapp).toEqual({ template_name: "po_document", template_language: "en_US", body_params: ["{{po_number}}", "5"] });
  });

  test("PDF format change: new POs get version N+1, old PO reprints with its own version", async () => {
    const cur = await get();
    const old = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).body;
    const fmt = { ...cur.format, footer: { ...cur.format.footer, terms: "NEW TERMS" }, columns: cur.format.columns.map((c) => (c.key === "hsn" ? { ...c, visible: false } : c)) };
    const saved = await adm().put(SET, { format: fmt });
    expect(saved.body.format_version).toBe(cur.format_version + 1);
    const neu = (await A.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(A.items.I1, 1)] })).body;
    expect(neu.format_version).toBe(cur.format_version + 1);
    const gOld = (await A.users.maker.api.get(`${P}/${old._id}`)).body;
    const gNew = (await A.users.maker.api.get(`${P}/${neu._id}`)).body;
    expect(gOld.format.footer.terms).toBe(cur.format.footer.terms);
    expect(gOld.format.columns.find((c) => c.key === "hsn").visible).toBe(cur.format.columns.find((c) => c.key === "hsn").visible);
    expect(gNew.format.footer.terms).toBe("NEW TERMS");
    expect(gNew.format.columns.find((c) => c.key === "hsn").visible).toBe(false);
  });

  test("switching a used division off is allowed; it is refused for new POs; old POs still open (finding 6b)", async () => {
    const po = (await A.users.maker.api.post(P, { type: "purchase", division: "sparkling", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] })).body;
    const cur = await get();
    const off = await adm().put(SET, { divisions: cur.divisions.map((d) => (d.key === "sparkling" ? { ...d, active: false } : d)) });
    expect(off.status).toBe(200);
    expect((await A.users.maker.api.post(P, { type: "purchase", division: "sparkling", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] })).status).toBe(400);
    expect((await A.users.maker.api.get(`${P}/${po._id}`)).status).toBe(200);
    // editing an old draft in a switched-off division still works (division isn't re-checked)
    const e = await A.users.maker.api.put(`${P}/${po._id}`, { customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 2)] });
    expect(e.status).toBe(200);
    await adm().put(SET, { divisions: cur.divisions });
  });

  test("[RECORD] prefix change mid-year continues the same counter with the new prefix", async () => {
    const cur = await get();
    const a = (await A.users.maker.api.post(P, { type: "purchase", division: "my-key", items: [S.line(A.items.I1, 1)] })).body;
    await adm().put(SET, { divisions: cur.divisions.map((d) => (d.key === "my-key" ? { ...d, purchase_prefix: "MK2-P" } : d)) });
    const b = (await A.users.maker.api.post(P, { type: "purchase", division: "my-key", items: [S.line(A.items.I1, 1)] })).body;
    expect(a.po_number).toBe(`MK-P/01/${fy}`);
    expect(b.po_number).toBe(`MK2-P/02/${fy}`);
  });
});

describe("6.3 NEGATIVE", () => {
  test("non-admin PUT -> 403 (every role, even with every PO cap)", async () => {
    for (const u of ["maker", "full", "approver", "pricer", "viewer", "own", "ownApprover", "roleApprover"]) {
      const r = await A.users[u].api.put(SET, { supplier: { name: "X" } });
      expect(r.status).toBe(403);
      expect(r.body.message).toBe("Only an admin can change PO settings");
    }
    expect((await get()).supplier.name).toBe("Brady India");
  });
  test("divisions [] / not an array -> 400", async () => {
    expect((await adm().put(SET, { divisions: [] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: "brady" })).status).toBe(400);
    expect((await adm().put(SET, { divisions: { a: 1 } })).status).toBe(400);
  });
  test("duplicate names / missing prefix / name '' / name only symbols -> 400", async () => {
    const cur = await get();
    const d = cur.divisions;
    expect((await adm().put(SET, { divisions: [...d, { name: "Brady", purchase_prefix: "X", sales_prefix: "Y" }] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: [...d, { name: "BRADY!", purchase_prefix: "X", sales_prefix: "Y" }] })).status).toBe(400);
    // R1: only the PO prefix is required now (the Sales PO prefix may be empty).
    expect((await adm().put(SET, { divisions: [...d, { name: "New", sales_prefix: "Y" }] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: [...d, { name: "New", purchase_prefix: "A/B" }] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: [...d, { name: "New", purchase_prefix: "  ", sales_prefix: "Y" }] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: [...d, { name: "", purchase_prefix: "X", sales_prefix: "Y" }] })).status).toBe(400);
    expect((await adm().put(SET, { divisions: [...d, { name: "&&&", purchase_prefix: "X", sales_prefix: "Y" }] })).status).toBe(400);
    expect((await get()).divisions).toEqual(d);
  });
  test("[FIXED] a null / non-object entry in divisions -> 400 'Every division needs a name' (was 500)", async () => {
    const cur = await get();
    for (const bad of [null, "brady", 5]) {
      const r = await adm().put(SET, { divisions: [...cur.divisions, bad] });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Every division needs a name");
    }
    expect((await get()).divisions).toEqual(cur.divisions);
  });
  test("removing a division that has POs -> 400; removing an unused one -> 200 (finding 6b)", async () => {
    const cur = await get();
    const r = await adm().put(SET, { divisions: cur.divisions.filter((d) => d.key !== "brady") });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/can't be removed/);
    // "unused" (seeded, no POs) can be removed
    const rm = await adm().put(SET, { divisions: cur.divisions.filter((d) => d.key !== "unused") });
    expect(rm.status).toBe(200);
    expect(rm.body.divisions.map((d) => d.key)).not.toContain("unused");
    // ...and it can be added back again
    const back = await adm().put(SET, { divisions: cur.divisions });
    expect(back.status).toBe(200);
    expect(back.body.divisions).toEqual(cur.divisions);
  });
  test("[FIXED] a prefix used twice (across divisions, across purchase/sales, any case) -> 400; settings unchanged", async () => {
    const cur = await get();
    const cases = [
      { name: "Clone", purchase_prefix: "PPO", sales_prefix: "C-SPO" },
      { name: "Clone", purchase_prefix: "C-P", sales_prefix: "ppo" },
      { name: "Clone", purchase_prefix: " spk-spo ", sales_prefix: "C-S" },
      { name: "Clone", purchase_prefix: "SAME", sales_prefix: "same" },
    ];
    for (const d of cases) {
      const r = await adm().put(SET, { divisions: [...cur.divisions, d] });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/^Number prefix ".+" is used twice/);
    }
    expect((await get()).divisions).toEqual(cur.divisions);
  });
  test("unique prefixes still save (positive after the fix) — by editing an existing division", async () => {
    const cur = await get();
    const r = await adm().put(SET, { divisions: cur.divisions.map((d) => (d.key === "brady-co" ? { ...d, sales_prefix: "FD-S", purchase_prefix: "FD-P" } : d)) });
    expect(r.status).toBe(200);
    // (Sales PO was removed — the new purchase prefix is the one that numbers POs)
    const c = await A.users.maker.api.post(P, { type: "purchase", division: "brady-co", customer: String(A.customers.c1._id), items: [S.line(A.items.I1, 1)] });
    expect(c.body.po_number).toBe(`FD-P/02/${fy}`);
    await adm().put(SET, { divisions: cur.divisions });
  });
  test("[FIXED] residual: re-using a prefix that USED to belong to another division (renamed earlier) -> 400 'already used on other POs'", async () => {
    // 6.2 renamed my-key's purchase prefix MK-P -> MK2-P after MK-P-<year>-0001 was issued.
    // (here an existing division tries to take it; a new division is checked in 6.4.)
    const cur = await get();
    const r = await adm().put(SET, { divisions: cur.divisions.map((d) => (d.key === "brady-co" ? { ...d, purchase_prefix: "MK-P" } : d)) });
    console.log("[record] historic prefix reuse ->", r.status, r.body.message);
    // keep later tests independent of this result: undo the save if it went through
    if (r.status === 200) await adm().put(SET, { divisions: cur.divisions });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Number prefix "MK-P" was already used on other POs — choose a new one');
    expect((await get()).divisions).toEqual(cur.divisions);
  });
  test("[FIXED] residual: an old prefix of the SAME division but the other PO type is refused too", async () => {
    const cur = await get();
    const divs = cur.divisions.map((d) => (d.key === "my-key" ? { ...d, sales_prefix: "MK-P", purchase_prefix: "MK3-P" } : d));
    const r = await adm().put(SET, { divisions: divs });
    if (r.status === 200) await adm().put(SET, { divisions: cur.divisions }); // undo, keep later tests independent
    expect(r.status).toBe(400);
  });
  test("a division may switch back to its OWN old prefix (same division + type) -> 200, numbering continues without collision", async () => {
    const cur = await get();
    const divs = cur.divisions.map((d) => (d.key === "my-key" ? { ...d, purchase_prefix: "MK-P" } : d));
    const r = await adm().put(SET, { divisions: divs });
    expect(r.status).toBe(200);
    const c = await A.users.maker.api.post(P, { type: "purchase", division: "my-key", items: [S.line(A.items.I1, 1)] });
    expect(c.status).toBe(201);
    expect(c.body.po_number).toBe(`MK-P/03/${fy}`);
  });
  test("saving settings unchanged (all current prefixes already printed on their own POs) still works", async () => {
    const cur = await get();
    const r = await adm().put(SET, { divisions: cur.divisions });
    expect(r.status).toBe(200);
  });
  test("rule percent -1, 101, 'abc' -> 400; list price field 'cost_price' / 'xyz' / missing -> 400 (finding 6c)", async () => {
    const base = { list_price_field: "end_customer_price", max_discount_pct: 25, min_margin_pct: 13, allow_below_list: true };
    for (const bad of [{ max_discount_pct: -1 }, { max_discount_pct: 101 }, { min_margin_pct: "abc" }, { list_price_field: "cost_price" }, { list_price_field: "xyz" }, { list_price_field: undefined }]) {
      const r = await adm().put(SET, { rules: { purchase: { ...base, ...bad } } });
      expect(r.status).toBe(400);
    }
    expect((await get()).rules.purchase).toEqual({ ...base, price_floor: true }); // G1 field, unchanged (on by default since R6)
  });
  test("supplier name '' -> 400 (finding 6e)", async () => {
    expect((await adm().put(SET, { supplier: { name: "" } })).status).toBe(400);
    expect((await adm().put(SET, { supplier: { name: "   " } })).status).toBe(400);
  });
  // Round 29 (S4): FIXED — supplier GSTIN / phone / WhatsApp / e-mail are checked.
  test("[FIXED r29] supplier GSTIN / phone / WhatsApp / e-mail validated (finding 6e) -> 400 per field, nothing saved", async () => {
    const before = (await get()).supplier;
    for (const [bad, field] of [
      [{ gstin: "not-a-gstin" }, "supplier.gstin"],
      [{ gstin: "99AAACB1234C1Z1" }, "supplier.gstin"],
      [{ phone: "abc" }, "supplier.phone"],
      [{ whatsapp: "12" }, "supplier.whatsapp"],
      [{ email: "not an email" }, "supplier.email"],
    ]) {
      const r = await adm().put(SET, { supplier: { name: "Brady India", ...bad } });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe(field);
    }
    expect((await get()).supplier).toEqual(before);
    // lower-case GSTIN is stored upper-cased
    const ok = await adm().put(SET, { supplier: { ...before, gstin: "27aaacb1234c1z1" } });
    expect(ok.body.supplier.gstin).toBe("27AAACB1234C1Z1");
    await adm().put(SET, { supplier: before });
  });
  test("whatsapp body_params not an array -> stored as []", async () => {
    const r = await adm().put(SET, { whatsapp: { template_name: "t", body_params: "{{po_number}}" } });
    expect(r.body.whatsapp.body_params).toEqual([]);
  });
  test("format as string -> ignored (no new version)", async () => {
    const cur = await get();
    const r = await adm().put(SET, { format: "hello" });
    expect(r.body.format_version).toBe(cur.format_version);
  });
  test("[BUG] format as an array is accepted and becomes a new version", async () => {
    const cur = await get();
    const r = await adm().put(SET, { format: [1, 2, 3] });
    expect(r.status).toBe(200);
    expect(r.body.format_version).toBe(cur.format_version + 1);
    expect(r.body.format).toEqual([1, 2, 3]);
    await adm().put(SET, { format: cur.format });
  });
  test("[BUG] format of ~5 MB is accepted (no size limit) and stored twice (format + history) (finding 6d)", async () => {
    const cur = await get();
    const big = { ...cur.format, footer: { ...cur.format.footer, terms: "T".repeat(5 * 1024 * 1024) } };
    const r = await adm().put(SET, { format: big });
    expect(r.status).toBe(200);
    expect(r.body.format_version).toBe(cur.format_version + 1);
  });
  test("[BUG] format_history grows without limit: after two 5 MB versions the next format save fails 500 (16 MB document limit); small saves still work", async () => {
    const cur = await get();
    const results = [];
    for (let i = 0; i < 3; i++) {
      const big = { ...cur.format, footer: { ...cur.format.footer, terms: `${i}`.repeat(5 * 1024 * 1024) } };
      results.push((await adm().put(SET, { format: big })).status);
    }
    const after = await adm().put(SET, { supplier: { name: "Still saves?" } });
    console.log("[record] 5MB formats x3 ->", results, "then supplier save ->", after.status, after.body.message && after.body.message.slice(0, 80));
    expect(results).toEqual([200, 500, 500]);
    expect(after.status).toBe(200);
  });
});

describe("6.x unknown keys + FINDINGS", () => {
  test("unknown top-level keys (counters, tenant_id, format_history, format_version, _id) ignored", async () => {
    const C = await S.seedTenant("C3");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${C.tenantId}`;
    const before = await PoSettings().findOne({ tenant_id: C.tenantId }).lean() || (await C.users.admin.api.get(SET), await PoSettings().findOne({ tenant_id: C.tenantId }).lean());
    const r = await C.users.admin.api.put(SET, { counters: { brady_purchase_2026: 999 }, tenant_id: String(A.tenantId), format_history: [], format_version: 77, _id: "x", supplier: { name: "C Supplier" } });
    expect(r.status).toBe(200);
    const after = await PoSettings().findOne({ tenant_id: C.tenantId }).lean();
    expect(after.counters).toEqual(before.counters);
    expect(after.format_version).toBe(1);
    expect(after.format_history).toHaveLength(1);
    expect(String(after._id)).toBe(String(before._id));
    const po = await C.users.admin.api.post(P, { type: "purchase", division: "brady", items: [S.line(C.items.I1, 1)] });
    expect(po.body.po_number).toBe(`PPO/01/${fy}`);
  });

  test("[QUESTION] 6a: every PO user (viewer, View(Own), pricer) can READ settings incl. supplier phone/e-mail/GSTIN + WhatsApp template", async () => {
    await adm().put(SET, { supplier: { name: "Brady India", phone: "022-12345678", email: "po@brady.test", gstin: "27AAACB1234C1Z1" } });
    for (const u of ["viewer", "own", "pricer"]) {
      const r = await A.users[u].api.get(SET);
      expect(r.status).toBe(200);
      expect(r.body.supplier).toMatchObject({ phone: "022-12345678", email: "po@brady.test" });
      expect(r.body.whatsapp).toBeDefined();
    }
    expect((await A.users.noAccess.api.get(SET)).status).toBe(403);
  });

  test("[RECORD] division name / PDF header XSS probes stored raw", async () => {
    const C = await S.seedTenant("C4");
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${C.tenantId}`;
    const probe = "<img src=x onerror=\"window.__xss=(window.__xss||0)+1\">";
    const cur = (await C.users.admin.api.get(SET)).body;
    // As a NEW division name the probe is stored raw (key cleaned from it) ...
    // 2026-10-28: a supplier name with < > is now refused (name rule) — no longer stored raw.
    const sup = await C.users.admin.api.put(SET, { supplier: { name: probe } });
    expect(sup.status).toBe(400);
    expect(sup.body).toMatchObject({ field: "supplier.name", message: "Supplier name can't contain < or >" });
    const r = await C.users.admin.api.put(SET, { divisions: [...cur.divisions, { name: probe, purchase_prefix: "X1", sales_prefix: "X2" }], format:{ ...cur.format, header: { ...cur.format.header, company_name: probe } } });
    expect(r.status).toBe(200);
    expect(r.body.divisions[2].name).toBe(probe);
    expect(r.body.divisions[2].key).toBe("img-src-x-onerror-window-xss-window-xss-0-1");
    // ... and also as the new name of an existing division (key kept).
    const renamed = await C.users.admin.api.put(SET, { divisions: r.body.divisions.map((d) => (d.key === "sparkling" ? { ...d, name: probe } : d)) });
    expect(renamed.status).toBe(200);
    expect(renamed.body.divisions[1]).toMatchObject({ key: "sparkling", name: probe });
    expect(r.body.format.header.company_name).toBe(probe);
  });
});

// A NEW company starts with Brady only (6.1); divisions can be added, edited,
// switched off or removed. The poStack seed gives each test company an extra
// "sparkling" division.
describe("6.4 divisions: add / remove / switch off (extra division 'sparkling')", () => {
  const fresh = async (label) => {
    const T = await S.seedTenant(label);
    process.env.PURCHASE_ORDERS_TENANT_IDS += `,${T.tenantId}`;
    const cur = (await T.users.admin.api.get(SET)).body;
    expect(cur.divisions.map((d) => d.key)).toEqual(["brady", "sparkling"]);
    return { T, cur };
  };
  // (was a Sales PO; R1 — Purchase PO in the extra division)
  const spkSales = (T) => T.users.maker.api.post(P, { type: "purchase", division: "sparkling", customer: String(T.customers.c1._id), items: [S.line(T.items.I1, 1)] });

  test("PUT with a new division -> 200 and saved; its first POs get <prefix>-<year>-0001; prefix rules still apply to added divisions", async () => {
    const { T, cur } = await fresh("D1");
    const r = await T.users.admin.api.put(SET, { divisions: [...cur.divisions, { name: "Third", purchase_prefix: "T-P", sales_prefix: "T-S" }] });
    expect(r.status).toBe(200);
    expect(r.body.divisions[2]).toEqual({ key: "third", name: "Third", purchase_prefix: "T-P", sales_prefix: "T-S", active: true });
    expect((await PoSettings().findOne({ tenant_id: T.tenantId }).lean()).divisions.map((d) => d.key)).toEqual(["brady", "sparkling", "third"]);
    const p = await T.users.maker.api.post(P, { type: "purchase", division: "third", items: [S.line(T.items.I1, 1)] });
    expect(p.body.po_number).toBe(`T-P/01/${fy}`);
    const s = await T.users.maker.api.post(P, { type: "sales", division: "third", customer: String(T.customers.c1._id), items: [S.line(T.items.I1, 1)] });
    expect(s.status).toBe(400); // R1: no Sales PO series any more
    const now = (await T.users.admin.api.get(SET)).body;
    // a prefix already used by another division / type -> 400, settings unchanged
    for (const bad of [{ name: "Fourth", purchase_prefix: "spk-ppo", sales_prefix: "F-S" }, { name: "Fourth", purchase_prefix: "F-P", sales_prefix: "T-P" }]) {
      const x = await T.users.admin.api.put(SET, { divisions: [...now.divisions, bad] });
      expect(x.status).toBe(400);
      expect(x.body.message).toMatch(/^Number prefix ".+" is used twice/);
    }
    // a prefix printed on POs earlier (Third moved from T-P to T2-P) can't go to a new division
    expect((await T.users.admin.api.put(SET, { divisions: now.divisions.map((d) => (d.key === "third" ? { ...d, purchase_prefix: "T2-P" } : d)) })).status).toBe(200);
    const after = (await T.users.admin.api.get(SET)).body;
    const reuse = await T.users.admin.api.put(SET, { divisions: [...after.divisions, { name: "Fourth", purchase_prefix: "T-P", sales_prefix: "F-S" }] });
    expect(reuse).toEqual({ status: 400, body: { message: 'Number prefix "T-P" was already used on other POs — choose a new one' } });
    expect((await T.users.admin.api.get(SET)).body.divisions).toEqual(after.divisions);
  });
  test("removing the unused extra division -> 200; then it's gone for new POs", async () => {
    const { T, cur } = await fresh("D2");
    const r = await T.users.admin.api.put(SET, { divisions: cur.divisions.filter((d) => d.key !== "sparkling") });
    expect(r.status).toBe(200);
    expect(r.body.divisions.map((d) => d.key)).toEqual(["brady"]);
    expect((await spkSales(T)).body).toEqual({ message: "Choose a division" });
  });
  test("removing it when it has POs -> 400 (settings unchanged); switching it off -> 200 and it's refused for new POs; old PO still opens", async () => {
    const { T, cur } = await fresh("D3");
    const po = await spkSales(T);
    expect(po.status).toBe(201);
    expect(po.body.po_number).toMatch(/^SPK-PPO\//);
    const rm = await T.users.admin.api.put(SET, { divisions: cur.divisions.filter((d) => d.key !== "sparkling") });
    expect(rm).toEqual({ status: 400, body: { message: "A division that already has POs can't be removed — switch it off instead" } });
    expect((await T.users.admin.api.get(SET)).body.divisions).toEqual(cur.divisions);
    const off = await T.users.admin.api.put(SET, { divisions: cur.divisions.map((d) => (d.key === "sparkling" ? { ...d, active: false } : d)) });
    expect(off.status).toBe(200);
    expect(off.body.divisions.find((d) => d.key === "sparkling").active).toBe(false);
    expect((await spkSales(T)).status).toBe(400);
    expect((await T.users.maker.api.get(`${P}/${po.body._id}`)).status).toBe(200);
    // switched back on -> usable again (not a "new" division)
    expect((await T.users.admin.api.put(SET, { divisions: cur.divisions })).status).toBe(200);
    expect((await spkSales(T)).status).toBe(201);
  });
  test("editing an existing division's name / prefixes still works", async () => {
    const { T, cur } = await fresh("D4");
    const r = await T.users.admin.api.put(SET, { divisions: cur.divisions.map((d) => (d.key === "brady" ? { ...d, name: "Brady India", purchase_prefix: "BPO" } : d)) });
    expect(r.status).toBe(200);
    expect(r.body.divisions[0]).toEqual({ key: "brady", name: "Brady India", purchase_prefix: "BPO", sales_prefix: "SPO", active: true });
    const p = await T.users.maker.api.post(P, { type: "purchase", division: "brady", items: [S.line(T.items.I1, 1)] });
    expect(p.body.po_number).toMatch(/^BPO\//);
  });
});
