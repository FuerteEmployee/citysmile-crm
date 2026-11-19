// Purchase Orders → PO Items → "Upload items (Excel)" for the real Brady price
// list (R3). The browser reads the workbook (every sheet as rows of cells) and
// posts it here:
//   POST /items/pricelist/scan     — header row + column mapping per sheet
//                                    (remembered mappings applied), skip reasons
//   POST /items/pricelist/preview  — records, duplicates across sheets with
//                                    both prices, errors, new/updated/unchanged
//   POST /items/pricelist/import   — saves one batch of records (the browser
//                                    sends ≤ 1000 per call and shows progress);
//                                    the last batch also saves the replacement
//                                    links and the confirmed mappings
// Everything needs Purchase Orders › Manage Prices. Nothing reads or writes
// the CRM Items module.
const PoItem = require("../models/PoItem");
const PoSettings = require("../models/PoSettings");
const ActivityLog = require("../models/ActivityLog");
const PL = require("../services/poPriceList");
const V = require("../services/poValidation");
const { _internal: H } = require("./purchase_order_controller");

const { httpError, fail, plain, tenantOf, getSettingsDoc, withItemLock, canManagePrices, logItemChanges } = H;

const MAX_BATCH = 1000;
// Q6: GST % per item; an item without one on the price list gets 18 %.
const DEFAULT_GST = 18;
// What a price-list record can set on a PO item.
const TEXT_LIMITS = { item_code: 100, y_code: 50, description: 2000, hsn: 50, unit: 30, lead_time: 100, remarks: 500, category: 100, price_sheet: 100 };
const PRICE_FIELDS = ["master_price", "distributor_price", "end_customer_price"];
const COMPARE = ["y_code", "description", "hsn", "unit", "lead_time", "remarks", "category", "price_sheet", ...PRICE_FIELDS, "tax_rate"];
// What the reference list keeps of each winning record (S6).
const REFERENCE_FIELDS = ["item_code", "y_code", "description", "unit", "hsn", "tax_rate", ...PRICE_FIELDS, "lead_time", "remarks", "category", "price_sheet", "attributes", "replaces"];
const isReplacementSheet = (name) => /new\s*replacement/i.test(name);

const savedMappings = (settings) => plain(settings).import_mappings || [];

// S1: a sheet's series — the name typed in the mapping step (checked like
// "New series…"), else the sheet name made into a valid series name; a name
// matching an existing series (any case) — saved, or another sheet of this
// upload — reuses it.
const seriesFor = (sheet, known) => {
  const typed = sheet.series === undefined || sheet.series === null || String(sheet.series).trim() === "" ? null : V.seriesName(sheet.series);
  if (typed && typed.error) throw httpError(400, `Sheet "${sheet.name}": ${typed.error}`, { field: "series" });
  const name = typed ? typed.value : V.seriesFromSheet(sheet.name);
  const hit = V.reuseSeries(name, known);
  if (!known.includes(hit)) known.push(hit);
  return hit;
};

// One sheet's mapping from the request: { "<col>": field } (or an array).
const cleanFields = (fields, width) => {
  if (fields === undefined || fields === null) return null;
  const arr = Array.isArray(fields) ? fields : Array.from({ length: width }, (_, c) => fields[c] ?? fields[String(c)]);
  if (arr.length > 200) throw httpError(400, "Too many columns");
  return arr.map((f) => {
    if (f === undefined || f === null || f === "") return "ignore";
    if (!PL.FIELDS.includes(f)) throw httpError(400, `Unknown field "${String(f).slice(0, 40)}"`);
    return f;
  });
};

// The sheets of a request, cleaned. 400 on anything malformed.
const sheetsFrom = (body) => {
  const { sheets, error } = PL.cleanSheets(body?.sheets);
  if (error) throw httpError(400, error);
  return sheets;
};

const scanPriceList = async (req, res) => {
  try {
    await canManagePrices(req);
    const sheets = sheetsFrom(req.body);
    const settings = await getSettingsDoc(tenantOf(req));
    const saved = savedMappings(settings);
    const existing = await H.existingSeries(tenantOf(req));
    const known = [...existing];
    const out = sheets.map((s, index) => ({ index, ...PL.detectSheet(s.name, s.rows, saved), series: seriesFor({ name: s.name }, known) }));
    res.json({
      sheets: out,
      existing_series: existing,
      priority: PL.defaultPriority(out.filter((s) => !s.skip_reason).map((s) => s.name)),
      fields: PL.FIELDS.map((f) => ({ value: f, label: PL.FIELD_LABELS[f] })),
      all_remembered: out.filter((s) => !s.skip_reason).every((s) => s.remembered),
    });
  } catch (error) {
    fail(res, error);
  }
};

const lower = (s) => String(s || "").toLowerCase();

// Existing PO items, looked up by catalog, by name, and (for records with no
// catalog) by Y code — all case-insensitive.
const indexItems = (items) => {
  const byCode = new Map();
  const byName = new Map();
  const byY = new Map();
  for (const i of items) {
    if (i.item_code) byCode.set(lower(i.item_code), i);
    byName.set(lower(i.name), i);
    if (i.y_code && !byY.has(lower(i.y_code))) byY.set(lower(i.y_code), i);
  }
  return {
    find: (rec) =>
      rec.item_code
        ? byCode.get(lower(rec.item_code)) || byName.get(lower(rec.item_code))
        : byY.get(lower(rec.y_code)) || byName.get(lower(rec.y_code)),
  };
};

const sameAttrs = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());

// What a record changes on an existing item (blank cells leave a value as it is).
const changesFor = (rec, item) => {
  const changes = {};
  for (const f of COMPARE) {
    const to = rec[f];
    if (to === undefined || to === "") continue;
    const from = item[f] ?? (PRICE_FIELDS.includes(f) || f === "tax_rate" ? 0 : "");
    if (from !== to) changes[f] = { from: from === "" ? null : from, to };
  }
  if (rec.item_code && item.item_code !== rec.item_code && lower(item.item_code) !== lower(rec.item_code)) {
    changes.item_code = { from: item.item_code || null, to: rec.item_code };
  }
  if (rec.attributes && !sameAttrs(rec.attributes, item.attributes)) changes.attributes = { from: item.attributes || null, to: rec.attributes };
  if (rec.replaces && !sameAttrs(Object.fromEntries((rec.replaces || []).map((r) => [r, 1])), Object.fromEntries((item.replaces || []).map((r) => [r, 1])))) {
    changes.replaces = { from: item.replaces || null, to: rec.replaces };
  }
  return changes;
};

// New / update / unchanged for every winning record against today's items.
const classify = (records, items) => {
  const idx = indexItems(items);
  return records.map((rec) => {
    const item = idx.find(rec);
    if (!item) return { ...rec, status: "new" };
    const changes = changesFor(rec, item);
    return { ...rec, item_id: String(item._id), status: Object.keys(changes).length ? "update" : "unchanged", changes };
  });
};

const previewPriceList = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const sheets = sheetsFrom(req.body);
    const settings = await getSettingsDoc(tenantId);
    const saved = savedMappings(settings);

    const sheetOut = [];
    const all = [];
    const known = await H.existingSeries(tenantId);
    const seriesOf = {}; // sheet name → series
    const refSheets = []; // every readable sheet (S6: the reference list)
    for (const s of sheets) {
      const detected = PL.detectSheet(s.name, s.rows, saved);
      const included = s.include !== false;
      let headerRow = detected.header_row;
      // -1 / null / missing = the detected header row. A sheet left out only
      // feeds the reference list: a bad header row / mapping there is ignored.
      if (s.header_row !== undefined && s.header_row !== null && s.header_row !== -1) {
        const bad = !Number.isInteger(s.header_row) || s.header_row < 0 || s.header_row >= s.rows.length;
        if (bad && included) throw httpError(400, `Sheet "${s.name}": header row is outside the sheet`);
        if (!bad) headerRow = s.header_row;
      }
      let given = null;
      try {
        given = cleanFields(s.fields, (s.rows[headerRow] || []).length);
      } catch (err) {
        if (included) throw err;
      }
      const fields = given || detected.columns.map((c) => c.field);
      const problem = headerRow < 0 ? detected.skip_reason : PL.mappingProblem(fields);
      const info = { name: s.name, included, header_row: headerRow, skip_reason: included ? problem : "Not selected", item_rows: 0, errors: 0, blank_rows: 0, reference_rows: 0 };
      if (!problem) {
        const { records, blank } = PL.extractRows(s.name, s.rows, headerRow, fields);
        // S1: the sheet's series (sheet name by default, or renamed). A sheet
        // left out with a bad typed name keeps its sheet name as series.
        let series;
        try {
          series = seriesFor(s, known);
        } catch (err) {
          if (included) throw err;
          series = seriesFor({ name: s.name }, known);
        }
        info.series = series;
        seriesOf[s.name] = series;
        records.forEach((r) => { r.category = series; });
        if (included) {
          info.item_rows = records.length;
          info.errors = records.filter((r) => r.error).length;
          info.blank_rows = blank;
        }
        info.reference_rows = records.filter((r) => !r.error).length;
        refSheets.push(s.name);
        all.push(...records);
      }
      sheetOut.push(info);
    }

    const importable = sheetOut.filter((s) => s.included && !s.skip_reason).map((s) => s.name);
    const ticked = new Set(importable);
    let priority = Array.isArray(req.body?.priority) ? req.body.priority.filter((n) => typeof n === "string") : [];
    priority = [...priority.filter((n) => refSheets.includes(n)), ...PL.defaultPriority(refSheets).filter((n) => !priority.includes(n))];
    const choices = req.body?.choices && typeof req.body.choices === "object" && !Array.isArray(req.body.choices) ? req.body.choices : {};

    // Duplicates are resolved over the WHOLE file (the reference), then only
    // the catalogs found on a ticked sheet are imported as PO items. An
    // imported item's series is its home sheet among the ticked ones.
    const resolved = PL.resolveDuplicates(all, priority, choices);
    const { winners, links, sheetsByKey } = resolved;
    const onTicked = (key) => (sheetsByKey.get(key) || []).filter((n) => ticked.has(n));
    const toImport = [];
    for (const w of winners) {
      const mine = onTicked(w.key);
      if (!mine.length) continue;
      const own = sheetsByKey.get(w.key) || [];
      const homeAll = own.find((n) => !isReplacementSheet(n)) || w.price_sheet;
      const rec = { ...w };
      if (!ticked.has(homeAll)) rec.category = seriesOf[mine.find((n) => !isReplacementSheet(n)) || mine[0]] ?? rec.category;
      toImport.push(rec);
    }
    const errors = resolved.errors.filter((e) => ticked.has(e.sheet));
    const duplicates = resolved.duplicates.filter((d) => d.options.some((o) => ticked.has(o.sheet)));
    const reference = winners.map((w) => Object.fromEntries(REFERENCE_FIELDS.filter((f) => w[f] !== undefined && w[f] !== "").map((f) => [f, w[f]])));
    const items = await PoItem.find({ tenant_id: tenantId }).select("item_code y_code name " + COMPARE.join(" ") + " attributes replaces").lean();
    const classified = classify(toImport, items);
    const count = (st) => classified.filter((r) => r.status === st).length;
    res.json({
      sheets: sheetOut,
      priority,
      summary: {
        new: count("new"),
        update: count("update"),
        unchanged: count("unchanged"),
        errors: errors.length,
        duplicates: duplicates.length,
        skipped_sheets: sheetOut.filter((s) => s.skip_reason).length,
        total: classified.length,
        // S6: what the reference list will keep (every readable sheet)
        reference: reference.length,
        reference_sheets: refSheets.length,
      },
      duplicates,
      errors: errors.slice(0, 1000).map((e) => ({ sheet: e.sheet, row: e.row, catalog: e.item_code || e.y_code || "", error: e.error })),
      links,
      // What the import will save (new + updated); unchanged items are left out.
      records: classified.filter((r) => r.status !== "unchanged"),
      // S6: the whole price list, for POST /items/pricelist/reference
      reference,
    });
  } catch (error) {
    fail(res, error);
  }
};

// One record from the browser → PO item values (validated again here).
const cleanRecord = (rec) => {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("Not a record");
  const out = {};
  for (const [f, max] of Object.entries(TEXT_LIMITS)) {
    const v = rec[f];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`${f}: enter text`);
    const s = String(v).trim();
    if (s.length > max) throw new Error(`${f.replace(/_/g, " ")} is too long`);
    if (s) out[f] = s;
  }
  if (out.y_code) {
    if (!/^Y\d{5,9}$/i.test(out.y_code)) throw new Error("Y code must be Y followed by 5 to 9 digits (e.g. Y5075406)");
    out.y_code = out.y_code.toUpperCase();
  }
  if (!out.item_code && !out.y_code) throw new Error("No catalog or Y code");
  if (!out.item_code) throw new Error("No catalog no. (Y code only) — not imported");
  for (const f of PRICE_FIELDS) {
    if (rec[f] === undefined || rec[f] === null) continue;
    const p = H.priceNum(rec[f]);
    if (Number.isNaN(p)) throw new Error(`${f.replace(/_/g, " ")} is not a valid amount`);
    if (p !== undefined) out[f] = p;
  }
  if (rec.tax_rate !== undefined && rec.tax_rate !== null) {
    const g = H.gstNum(rec.tax_rate);
    if (Number.isNaN(g)) throw new Error("GST % must be a number from 0 to 100");
    if (g !== undefined) out.tax_rate = g;
  }
  if (rec.attributes !== undefined && rec.attributes !== null) {
    if (typeof rec.attributes !== "object" || Array.isArray(rec.attributes)) throw new Error("attributes must be an object");
    const entries = Object.entries(rec.attributes).slice(0, 30).map(([k, v]) => [String(k).replace(/[.$]/g, " ").trim().slice(0, 60), String(v ?? "").slice(0, 200)]);
    if (entries.length) out.attributes = Object.fromEntries(entries.filter(([k]) => k));
  }
  if (rec.replaces !== undefined && rec.replaces !== null) {
    if (!Array.isArray(rec.replaces)) throw new Error("replaces must be a list");
    out.replaces = rec.replaces.slice(0, 10).map((r) => String(r).trim().slice(0, 100)).filter(Boolean);
  }
  return out;
};

// Saves one batch. Matching is done again here, inside the item lock, against
// what is saved now — so two uploads at once can't both add the same catalog.
const importPriceList = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const records = req.body?.records;
    if (!Array.isArray(records)) throw httpError(400, "records must be a list");
    if (records.length > MAX_BATCH) throw httpError(400, `Send at most ${MAX_BATCH} records per batch`);
    const links = req.body?.links;
    const mappings = req.body?.mappings;
    if (links !== undefined && !Array.isArray(links)) throw httpError(400, "links must be a list");
    if (mappings !== undefined && !Array.isArray(mappings)) throw httpError(400, "mappings must be a list");
    if (!records.length && !links?.length && !mappings?.length) throw httpError(400, "Nothing to import");

    const result = await withItemLock(tenantId, async () => {
      const errors = [];
      const clean = [];
      records.forEach((rec, i) => {
        try {
          clean.push({ ...cleanRecord(rec), _i: i, _sheet: rec?.sheet, _row: rec?.row });
        } catch (err) {
          errors.push({ index: i, sheet: rec?.sheet, row: rec?.row, catalog: rec?.item_code || rec?.y_code || "", error: err.message });
        }
      });
      const items = await PoItem.find({ tenant_id: tenantId }).lean();
      const idx = indexItems(items);
      const seen = new Set();
      const updates = [];
      const news = [];
      let unchanged = 0;
      for (const rec of clean) {
        const key = lower(rec.item_code || rec.y_code);
        if (seen.has(key)) {
          errors.push({ index: rec._i, sheet: rec._sheet, row: rec._row, catalog: rec.item_code || rec.y_code, error: "Same catalog twice in this batch" });
          continue;
        }
        seen.add(key);
        const values = Object.fromEntries(Object.entries(rec).filter(([k]) => !k.startsWith("_")));
        const item = idx.find(values);
        if (!item) {
          news.push({
            ...values,
            name: values.item_code || values.y_code,
            tax_rate: values.tax_rate ?? DEFAULT_GST,
            unit: values.unit || "Nos",
            tenant_id: tenantId,
            created_by: req.user._id,
          });
          continue;
        }
        const changes = changesFor(values, item);
        if (!Object.keys(changes).length) {
          unchanged++;
          continue;
        }
        updates.push({ item, changes });
      }
      if (updates.length) {
        await PoItem.bulkWrite(
          updates.map(({ item, changes }) => ({
            updateOne: {
              filter: { _id: item._id, tenant_id: tenantId },
              update: { $set: Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to])) },
            },
          }))
        );
      }
      const docs = news.length ? await PoItem.insertMany(news) : [];

      // Obsolete → replacement: an item whose catalog is now obsolete points at
      // the new one (picking it on a PO suggests the replacement).
      let linked = 0;
      if (Array.isArray(links) && links.length) {
        const all = await PoItem.find({ tenant_id: tenantId }).select("item_code replaced_by replaces").lean();
        const byCode = new Map(all.filter((i) => i.item_code).map((i) => [lower(i.item_code), i]));
        const ops = [];
        for (const l of links.slice(0, 20000)) {
          const oldCode = String(l?.old_catalog || "").trim().slice(0, 100);
          const old = byCode.get(lower(oldCode));
          const to = String(l?.new_catalog || "").trim().slice(0, 100);
          if (old && to && lower(old.item_code) !== lower(to) && old.replaced_by !== to) {
            ops.push({ updateOne: { filter: { _id: old._id }, update: { $set: { replaced_by: to } } } });
          }
          // S5.3: the obsolete catalog is NOT an item (the real price list):
          // the link lives on the new item's "replaces", so searching the old
          // catalog in the PO editor's picker finds the new item.
          const neu = byCode.get(lower(to));
          if (!old && neu && oldCode && !(neu.replaces || []).some((r) => lower(r) === lower(oldCode))) {
            ops.push({ updateOne: { filter: { _id: neu._id }, update: { $addToSet: { replaces: oldCode } } } });
            neu.replaces = [...(neu.replaces || []), oldCode];
          }
        }
        if (ops.length) await PoItem.bulkWrite(ops);
        linked = ops.length;
      }
      return { updates, docs, unchanged, errors, linked };
    });

    // Confirmed column mappings, so the next upload of this layout is one click.
    let remembered = 0;
    if (Array.isArray(mappings) && mappings.length) {
      const settings = await getSettingsDoc(tenantId);
      const list = plain(settings).import_mappings || [];
      for (const m of mappings.slice(0, 100)) {
        if (!m || typeof m.signature !== "string" || !m.signature || m.signature.length > 3000) continue;
        const fields = cleanFields(m.fields, Array.isArray(m.fields) ? m.fields.length : Object.keys(m.fields || {}).length);
        if (!fields || PL.mappingProblem(fields)) continue;
        const entry = { signature: m.signature, sheet_name: String(m.sheet_name || "").slice(0, 100), fields: Object.fromEntries(fields.map((f, i) => [String(i), f])), saved_at: new Date(), saved_by: req.user._id };
        const at = list.findIndex((x) => x.signature === m.signature);
        if (at >= 0) list[at] = entry;
        else list.push(entry);
        remembered++;
      }
      await PoSettings.updateOne({ _id: settings._id }, { $set: { import_mappings: list.slice(-100) } });
    }

    const { updates, docs, unchanged, errors, linked } = result;
    logItemChanges(req, updates.map(({ item, changes }) => ({ item: { _id: item._id, name: item.name, tenant_id: tenantId }, changes })));
    if (docs.length) {
      ActivityLog.create({
        description: `PO items: price list upload added ${docs.length} item${docs.length === 1 ? "" : "s"}`,
        staffid: req.user._id,
        rel_type: "po_item",
        tenant_id: tenantId,
      }).catch((err) => console.error("[purchase orders] PO item log failed:", err.message));
    }
    res.json({ created: docs.length, updated: updates.length, unchanged, errors, linked, remembered });
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

module.exports = { scanPriceList, previewPriceList, importPriceList, cleanRecord, classify };
