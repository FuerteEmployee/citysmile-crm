// Round 30 (S6): the reference price list + "+ Add Catalog No."
//   POST /items/pricelist/reference  — saves one batch of the WHOLE price list
//        (the upload wizard sends it after the import); the batch with
//        done: true switches the company to this upload and deletes the old
//        reference. Manage Prices.
//   GET  /items/pricelist/reference  — { count, file_name, uploaded_at }
//   POST /items/catalog/find  { text }   — look catalog nos. up (anyone who
//        can open Purchase Orders: the PO editor's picker uses it)
//   POST /items/catalog/add   { text }   — copy the found ones into PO Items
//        (series = their sheet, prices from the price list). Manage Prices.
const mongoose = require("mongoose");
const PoItem = require("../models/PoItem");
const PoSettings = require("../models/PoSettings");
const Entry = require("../models/PoPriceListEntry");
const ActivityLog = require("../models/ActivityLog");
const REF = require("../services/poReference");
const { cleanRecord } = require("./purchase_order_pricelist_controller");
const { _internal: H } = require("./purchase_order_controller");

const { httpError, fail, tenantOf, getSettingsDoc, withItemLock, canManagePrices, escapeRegExp, can } = H;

const MAX_BATCH = 2000;
const MAX_ENTRIES = 50000;
const NO_REFERENCE = "Upload the price list first";
const UPLOAD_ID = /^[A-Za-z0-9-]{8,64}$/;

const refOf = (settings) => {
  const r = settings?.price_list_ref || {};
  return r.upload_id ? { upload_id: r.upload_id, count: r.count || 0, file_name: r.file_name || "", uploaded_at: r.uploaded_at || null } : null;
};
const publicRef = (r) => (r ? { count: r.count, file_name: r.file_name, uploaded_at: r.uploaded_at } : { count: 0, file_name: "", uploaded_at: null });

const saveReference = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const { upload_id: uploadId, entries = [], done, file_name: fileName } = req.body || {};
    if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw httpError(400, "upload_id is missing or not valid");
    if (!Array.isArray(entries)) throw httpError(400, "entries must be a list");
    if (entries.length > MAX_BATCH) throw httpError(400, `Send at most ${MAX_BATCH} entries per batch`);
    if (!entries.length && done !== true) throw httpError(400, "Nothing to save");
    const tid = new mongoose.Types.ObjectId(String(tenantId));

    const errors = [];
    const docs = [];
    entries.forEach((rec, i) => {
      try {
        const v = cleanRecord(rec);
        const series = typeof rec.category === "string" ? rec.category.trim().slice(0, 100) : "";
        const sheet = typeof rec.price_sheet === "string" ? rec.price_sheet.trim().slice(0, 100) : typeof rec.sheet === "string" ? rec.sheet.trim().slice(0, 100) : "";
        const doc = { ...v, category: series, price_sheet: sheet, tenant_id: tid, upload_id: uploadId };
        docs.push({ ...doc, ...REF.entryKeys(doc) });
      } catch (err) {
        errors.push({ index: i, catalog: rec?.item_code || rec?.y_code || "", error: err.message });
      }
    });
    if (docs.length) {
      const already = await Entry.countDocuments({ tenant_id: tid, upload_id: uploadId });
      if (already + docs.length > MAX_ENTRIES) throw httpError(400, `The price list has more than ${MAX_ENTRIES.toLocaleString("en-IN")} items`);
      await Entry.insertMany(docs, { ordered: false });
    }
    if (done !== true) return res.json({ saved: docs.length, errors });

    const count = await Entry.countDocuments({ tenant_id: tid, upload_id: uploadId });
    if (!count) throw httpError(400, "The price list has no items to keep");
    const settings = await getSettingsDoc(tenantId);
    const ref = { upload_id: uploadId, count, file_name: typeof fileName === "string" ? fileName.slice(0, 200) : "", uploaded_at: new Date(), uploaded_by: req.user._id };
    await PoSettings.updateOne({ _id: settings._id }, { $set: { price_list_ref: ref } });
    // The old reference (and any half-sent upload) goes.
    const removed = await Entry.deleteMany({ tenant_id: tid, upload_id: { $ne: uploadId } });
    ActivityLog.create({
      description: `PO items: reference price list replaced — ${count} catalog no${count === 1 ? "" : "s"} kept${ref.file_name ? ` (${ref.file_name})` : ""}`,
      staffid: req.user._id,
      rel_type: "po_item",
      tenant_id: tenantId,
    }).catch((err) => console.error("[purchase orders] reference log failed:", err.message));
    res.json({ saved: docs.length, errors, done: true, count, removed: removed.deletedCount || 0 });
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

const referenceStatus = async (req, res) => {
  try {
    res.json(publicRef(refOf(await getSettingsDoc(tenantOf(req)))));
  } catch (error) {
    fail(res, error);
  }
};

const ciIn = (values) => ({ $in: values.filter(Boolean).map((v) => new RegExp(`^${escapeRegExp(v)}$`, "i")) });

// One result per typed token: found / already (in PO Items) / not_found.
const lookup = async (tenantId, list) => {
  const settings = await getSettingsDoc(tenantId);
  const ref = refOf(settings);
  if (!ref) throw httpError(400, NO_REFERENCE, { code: "no_reference" });
  const tid = new mongoose.Types.ObjectId(String(tenantId));
  const lows = list.map(REF.lower);
  const entries = await Entry.find({ tenant_id: tid, upload_id: ref.upload_id, $or: [{ code_lc: { $in: lows } }, { y_lc: { $in: lows } }, { replaces_lc: { $in: lows } }] }).lean();
  const picked = list.map((q) => ({ q, hit: REF.pickEntry(q, entries) }));
  const codes = [...list, ...picked.filter((p) => p.hit).map((p) => p.hit.entry.item_code)];
  const items = await PoItem.find({ tenant_id: tenantId, $or: [{ item_code: ciIn(codes) }, { y_code: ciIn(list) }, { replaces: ciIn(list) }] })
    .select("item_code y_code name category active replaces")
    .lean();
  const itemFor = (q, entry) => {
    const lq = REF.lower(q);
    const direct = items.find((i) => REF.lower(i.item_code) === lq) || items.find((i) => REF.lower(i.y_code) === lq) || items.find((i) => (i.replaces || []).some((r) => REF.lower(r) === lq));
    if (direct) return direct;
    return entry && entry.item_code ? items.find((i) => REF.lower(i.item_code) === REF.lower(entry.item_code)) : null;
  };
  const results = picked.map(({ q, hit }) => {
    const item = itemFor(q, hit && hit.entry);
    const base = { query: q, via: hit ? hit.via : null, note: hit ? hit.note : "", entry: hit ? REF.publicEntry(hit.entry) : null, _entry: hit ? hit.entry : null };
    if (item) return { ...base, status: "already", message: "Already in PO Items", item: { _id: String(item._id), item_code: item.item_code || "", name: item.name, category: item.category || "", active: item.active !== false } };
    // Every PO item needs a catalog no.: a price-list row with only a Y code can't be added from here.
    if (hit && !hit.entry.item_code) return { ...base, status: "not_found", message: "No catalog no. for this in the price list — add it by hand with its catalog no." };
    if (hit) return { ...base, status: "found", message: "" };
    return { ...base, status: "not_found", message: "Not in the uploaded price list — add it by hand" };
  });
  return { ref, results };
};

const strip = (r) => {
  const { _entry, ...rest } = r;
  return rest;
};
const summaryOf = (results) => ({
  found: results.filter((r) => r.status === "found").length,
  already: results.filter((r) => r.status === "already").length,
  not_found: results.filter((r) => r.status === "not_found").length,
});

const findCatalogs = async (req, res) => {
  try {
    const parsed = REF.parseCatalogList(req.body?.text ?? req.body?.catalogs);
    if (parsed.error) throw httpError(400, parsed.error, { field: "text" });
    const { ref, results } = await lookup(tenantOf(req), parsed.list);
    res.json({ reference: publicRef(ref), can_add: await can(req, "Manage Prices"), summary: summaryOf(results), results: results.map(strip) });
  } catch (error) {
    fail(res, error);
  }
};

const addCatalogs = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const parsed = REF.parseCatalogList(req.body?.text ?? req.body?.catalogs);
    if (parsed.error) throw httpError(400, parsed.error, { field: "text" });
    const out = await withItemLock(tenantId, async () => {
      const { results } = await lookup(tenantId, parsed.list);
      const added = [];
      const seen = new Set();
      for (const r of results) {
        if (r.status !== "found") continue;
        const key = REF.lower(r._entry.item_code || r._entry.y_code);
        if (seen.has(key)) {
          // e.g. a catalog and its Y code pasted together: added once
          r.status = "already";
          r.message = "Already in PO Items";
          continue;
        }
        seen.add(key);
        added.push({ r, values: { ...REF.itemFromEntry(r._entry), tenant_id: tenantId, created_by: req.user._id } });
      }
      const docs = added.length ? await PoItem.insertMany(added.map((a) => a.values)) : [];
      docs.forEach((d, i) => {
        const r = added[i].r;
        r.status = "added";
        r.message = "Added to PO Items";
        r.item = { _id: String(d._id), item_code: d.item_code || "", name: d.name, category: d.category || "", active: true };
      });
      return { results, docs };
    });
    if (out.docs.length) {
      ActivityLog.create({
        description: `PO items: added from the price list — ${out.docs.map((d) => d.item_code || d.name).slice(0, 20).join(", ")}${out.docs.length > 20 ? ` and ${out.docs.length - 20} more` : ""}`,
        staffid: req.user._id,
        rel_type: "po_item",
        tenant_id: tenantId,
      }).catch((err) => console.error("[purchase orders] PO item log failed:", err.message));
    }
    const results = out.results.map(strip);
    res.status(out.docs.length ? 201 : 200).json({
      added: out.docs.length,
      summary: { added: out.docs.length, ...summaryOf(results) },
      results,
      items: out.docs.map((d) => d.toObject()),
    });
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

module.exports = { saveReference, referenceStatus, findCatalogs, addCatalogs, NO_REFERENCE };
