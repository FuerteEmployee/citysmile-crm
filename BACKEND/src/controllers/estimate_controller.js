const Estimate = require("../models/Estimate");
const InvoiceService = require("../services/InvoiceService");
const CustomFieldService = require("../services/CustomFieldService");
const Client = require("../models/Client");
const { logActivity } = require("../services/ActivityLogService");
const docSettings = require("../services/docSettings");

// Staff with "View (Own)" (or only "assigned" access) see the estimates they
// created or are the sale agent of.
const OWNER_FIELDS = ["created_by", "sale_agent"];
const estimateScope = (req) => docSettings.docScope(req, OWNER_FIELDS);
const duplicateNumberError = (res, number) =>
  res.status(400).json({ message: `Estimate number "${number}" is already used by another estimate.` });

const enrichEstimates = async (estimates) => {
  const cfByEstimate = await CustomFieldService.getValuesForMany(estimates.map((e) => e._id), "estimate");
  return estimates.map((est) => {
    const estObj = est.toObject();
    estObj.custom_fields = cfByEstimate.get(String(est._id)) || {};
    return estObj;
  });
};

const getEstimates = async (req, res) => {
  try {
    const filter = estimateScope(req);

    const { page, limit, search, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard aggregation, the customer-tab estimate list, exports)
    // keep getting the full bare array exactly as before.
    if (!isPaginated) {
      const estimates = await Estimate.find(filter)
        .populate("client", "company")
        .populate("invoice_id", "number")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 });
      return res.json(await enrichEstimates(estimates));
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      // Company Name is displayed by joined Client name (the "client" ref is
      // the one actually populated/used by the frontend) — resolve which
      // clients match so that column is searchable too.
      const matchingClients = await Client.find({ company: re }).select("_id");
      // $and: the scope may already use $or (own/assigned staff).
      filter.$and = [{ $or: [
        { number: re },
        { branch: re },
        { connectPerson: re },
        { phone: re },
        { mailId: re },
        { salesPerson: re },
        { "items.description": re },
        { client: { $in: matchingClients.map((c) => c._id) } },
      ] }];
    }
    if (branch) filter.branch = branch;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, estimates] = await Promise.all([
      Estimate.countDocuments(filter),
      Estimate.find(filter)
        .populate("client", "company")
        .populate("invoice_id", "number")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichEstimates(estimates),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getEstimateById = async (req, res) => {
  try {
    const estimate = await Estimate.findOne({ _id: req.params.id, ...estimateScope(req) })
      .populate("client", "company contact_person email phonenumber address city state zip country billing_street billing_city billing_state billing_zip billing_country shipping_street shipping_city shipping_state shipping_zip shipping_country gst_number pan_number vat currency")
      .populate("invoice_id", "number")
      .populate({ path: "bank_detail", populate: { path: "branch" } });
    if (!estimate) return res.status(404).json({ message: "Estimate not found" });
    const cf_values = await CustomFieldService.getValues(estimate._id, "estimate");
    const estObj = estimate.toObject();
    estObj.custom_fields = cf_values;
    await docSettings.addDisplayNames(estObj, "sale_agent");
    res.json(estObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createEstimate = async (req, res) => {
  try {
    const payload = { ...req.body };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") delete payload[key];
    });
    const autoNumber = !!payload.auto_number || !String(payload.number || "").trim();
    delete payload.auto_number;
    const tenantId = req.user?.tenant_id;
    const cfg = await docSettings.getDocSettings("estimate", tenantId);
    if (!payload.expirydate) payload.expirydate = docSettings.addDays(payload.date, cfg.dueAfter);
    const totals = InvoiceService.calculateTotals(payload);
    const doc = { ...payload, ...totals, tenant_id: tenantId, created_by: req.user?._id };
    let estimate;
    try {
      // Setup > Settings > Estimates: Prefix + Next Number + Number Format.
      estimate = autoNumber
        ? await docSettings.createWithNextNumber("estimate", tenantId, payload.date, (number) => Estimate.create({ ...doc, number }))
        : await Estimate.create(doc);
    } catch (err) {
      if (err?.code === 11000) return duplicateNumberError(res, payload.number);
      throw err;
    }
    if (estimate) {
      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(estimate._id, "estimate", req.body.custom_fields, estimate.tenant_id);
      }
      logActivity(req, `Created estimate: ${estimate.number || estimate._id}`, { rel_id: estimate._id, rel_type: "estimate" });
      res.status(201).json(estimate);
    } else {
      res.status(400).json({ message: "Invalid estimate data" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const convertToInvoice = async (req, res) => {
  try {
    const estimate = await Estimate.findOne({ _id: req.params.id, ...estimateScope(req) });
    if (!estimate) return res.status(404).json({ message: "Estimate not found" });

    const Invoice = require("../models/Invoice");
    // Converting twice made two invoices for the same estimate.
    if (estimate.invoice_id && (await Invoice.exists({ _id: estimate.invoice_id }))) {
      return res.status(400).json({ message: "This estimate has already been converted to an invoice." });
    }

    // Create invoice from estimate data
    // Same numbering / due date / terms as a new invoice (Setup > Settings >
    // Invoices), in the estimate's own company — it used to take the last
    // invoice of ANY company and save the invoice without a company.
    const invoiceSettings = require("../services/invoiceSettings");
    const tenantId = estimate.tenant_id || req.user?.tenant_id;
    const cfg = await invoiceSettings.getInvoiceSettings(tenantId);
    const date = new Date();
    // Totals and the CGST/SGST vs IGST split are worked out the same way as a
    // new invoice, not copied from the estimate (which never stored the split).
    const Client = require("../models/Client");
    const { isEkagraUser } = require("../middleware/auth");
    const client = await Client.findById(estimate.client);
    const { totalTax, ...totals } = InvoiceService.calculateTotals(
      estimate.toObject(), client, isEkagraUser(req.user) ? { name: "bihar", code: "10" } : undefined
    );

    const invoice = await invoiceSettings.createWithNextNumber(tenantId, date, (number) =>
      Invoice.create({
        client: estimate.client,
        number,
        tenant_id: tenantId,
        date,
        duedate: new Date(date.getTime() + cfg.dueAfter * 24 * 60 * 60 * 1000),
        items: estimate.items,
        ...totals,
        discount_percent: estimate.discount_percent,
        adjustment: estimate.adjustment,
        currency: estimate.currency,
        notes: cfg.clientNote || undefined,
        terms: cfg.terms,
      })
    );

    estimate.status = "accepted";
    estimate.invoice_id = invoice._id;
    await estimate.save();

    res.status(201).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateEstimate = async (req, res) => {
  try {
    const estimate = await Estimate.findOne({ _id: req.params.id, ...estimateScope(req) });
    if (estimate) {
      const payload = { ...req.body };
      Object.keys(payload).forEach(key => {
        if (payload[key] === "") delete payload[key];
      });
      ["auto_number", "tenant_id", "created_by"].forEach((k) => delete payload[k]);
      const hasFinancialUpdates = payload.items !== undefined || payload.discount_percent !== undefined || payload.discount_fixed !== undefined || payload.adjustment !== undefined;
      if (hasFinancialUpdates) {
        const itemsToCalc = payload.items !== undefined ? payload.items : estimate.items;
        const totals = InvoiceService.calculateTotals({ ...estimate.toObject(), ...payload, items: itemsToCalc });
        Object.assign(estimate, { ...payload, ...totals });
      } else {
        Object.assign(estimate, payload);
      }
      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(estimate._id, "estimate", req.body.custom_fields, estimate.tenant_id);
      }
      let updatedEstimate;
      try {
        updatedEstimate = await estimate.save();
      } catch (err) {
        if (err?.code === 11000) return duplicateNumberError(res, payload.number);
        throw err;
      }
      logActivity(req, `Updated estimate: ${updatedEstimate.number || updatedEstimate._id}`, { rel_id: updatedEstimate._id, rel_type: "estimate" });
      res.json(updatedEstimate);
    } else {
      res.status(404).json({ message: "Estimate not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteEstimate = async (req, res) => {
  try {
    const estimate = await Estimate.findOne({ _id: req.params.id, ...estimateScope(req) });
    if (estimate) {
      const notLast = await docSettings.notLastMessage("estimate", estimate);
      if (notLast) return res.status(400).json({ message: notLast });
      const estimateNumber = estimate.number || estimate._id;
      await estimate.deleteOne();
      await docSettings.releaseNumberOnDelete("estimate", estimate.tenant_id, estimate);
      logActivity(req, `Deleted estimate: ${estimateNumber}`, { rel_type: "estimate" });
      res.json({ message: "Estimate removed" });
    } else {
      res.status(404).json({ message: "Estimate not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Safely parse a date value that may come from:
 *  - An Excel serial number (integer, e.g. 46017 = 2026-01-01)
 *  - A JS timestamp in milliseconds (large integer)
 *  - An ISO / locale date string
 * Returns a valid Date object, or null if unparseable.
 */
const parseDate = (val) => {
  if (val === undefined || val === null || val === "") return null;
  // Numeric value — distinguish Excel serial vs JS timestamp
  if (typeof val === "number" || (typeof val === "string" && /^\d+(\.\d+)?$/.test(val.trim()))) {
    const num = Number(val);
    if (Number.isFinite(num)) {
      if (num > 0 && num < 200000) {
        // Excel serial: days since 1900-01-00 (Excel incorrectly treats 1900 as leap year, so offset is 25569 for 1970-01-01)
        const MS_PER_DAY = 86400000;
        const EXCEL_EPOCH_DIFF = 25569; // days between 1900-01-00 and 1970-01-01
        const d = new Date((num - EXCEL_EPOCH_DIFF) * MS_PER_DAY);
        if (!isNaN(d)) return d;
      } else {
        // Likely a JS timestamp in ms
        const d = new Date(num);
        if (!isNaN(d)) return d;
      }
    }
  }
  // Handle DD-MM-YYYY or DD/MM/YYYY strings explicitly since new Date() fails on them
  if (typeof val === "string") {
    const parts = val.split(/[-/]/);
    if (parts.length === 3 && parts[0].length === 2 && parts[2].length === 4) {
      // It's DD-MM-YYYY
      const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // String date
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const importEstimates = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.estimates;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid estimate data provided" });
    }

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};
    console.log("[importEstimates] user tenant_id:", tenantId, "| rows to import:", rowsRaw.length);

    // Register-style import: one row per LINE ITEM. Columns are:
    // Company Name | Connect Person | Phone Number | Mail Id | Item | Quantity | Rate | Amount | Sales Person | Date
    // Rows sharing the same Company Name + Date are grouped into a single
    // Estimate document, each row becoming one entry in items[]. This also
    // still accepts the legacy "To"/"company"/"Company" + "Estimate #" columns
    // for backwards compatibility with older exports.
    // Header casing varies across sheets (e.g. "Company Name" vs "company Name"),
    // so match column names case/space-insensitively instead of by exact key.
    const normalizeKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9#]/g, "");
    const rowKeyMaps = new Map(); // rowIndex -> Map(normalizedKey -> actualKey)
    rowsRaw.forEach((r, i) => rowKeyMaps.set(i, new Map(Object.keys(r).map(k => [normalizeKey(k), k]))));
    const getField = (r, keyMap, ...names) => {
      for (const name of names) {
        const actualKey = keyMap.get(normalizeKey(name));
        if (actualKey !== undefined && r[actualKey] !== undefined && r[actualKey] !== "") return r[actualKey];
      }
      return undefined;
    };

    const getCompanyName = (r, keyMap) => getField(r, keyMap, "Company Name", "To", "company", "Company") || "";
    const companyNames = [...new Set(rowsRaw.map((r, i) => getCompanyName(r, rowKeyMaps.get(i))).filter(Boolean))];
    // Fetch existing clients
    const clientDocs = companyNames.length
      ? await Client.find({ company: { $in: companyNames.map(c => new RegExp(`^${c}$`, 'i')) }, ...tenantFilter }).select("_id company")
      : [];
    const clientMap = new Map(clientDocs.map(c => [c.company.toLowerCase().trim(), c._id]));

    // Auto-create any clients that don't exist yet so no row is skipped
    const missingNames = companyNames.filter(n => !clientMap.has(n.toLowerCase().trim()));
    if (missingNames.length) {
      const created = await Client.insertMany(
        missingNames.map(name => ({ company: name, tenant_id: tenantId })),
        { ordered: false }
      );
      created.forEach(c => clientMap.set(c.company.toLowerCase().trim(), c._id));
      console.log("[importEstimates] auto-created clients:", missingNames);
    }

    const baseTs = Date.now();

    const VALID_STATUSES = ["draft", "sent", "declined", "accepted", "expired"];
    const normalizeStatus = (s) => {
      if (!s) return "draft";
      const lower = String(s).toLowerCase().trim();
      return VALID_STATUSES.includes(lower) ? lower : "draft";
    };

    const toNumber = (v) => {
      const n = Number(String(v ?? "0").replace(/[^0-9.-]+/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    // Group rows into one estimate per (company + date) — or per "Estimate #"
    // if that legacy column is present in the sheet — so multiple item rows
    // fold into a single Estimate with multiple items[] entries.
    const groups = new Map(); // groupKey -> { meta, items: [], estimateNumber }
    const unmatchedCompanies = new Set();
    let groupCounter = 0;
    for (let i = 0; i < rowsRaw.length; i++) {
      const r = rowsRaw[i];
      const keyMap = rowKeyMaps.get(i);
      const companyName = String(getCompanyName(r, keyMap)).toLowerCase().trim();
      let clientId = clientMap.get(companyName);
      // If still no client (edge case: empty company name), create a placeholder
      if (!clientId) {
        if (companyName) {
          try {
            const newClient = await Client.create({ company: companyName, tenant_id: tenantId });
            clientId = newClient._id;
            clientMap.set(companyName, clientId);
          } catch (e) {
            // Possible race condition — try to fetch again
            const found = await Client.findOne({ company: new RegExp(`^${companyName}$`, 'i'), ...tenantFilter }).select("_id");
            if (found) { clientId = found._id; clientMap.set(companyName, clientId); }
          }
        } else {
          // Truly no company name — still import with a placeholder
          try {
            const placeholder = await Client.create({ company: `Imported-${Date.now()}`, tenant_id: tenantId });
            clientId = placeholder._id;
          } catch (e) { /* ignore */ }
        }
        if (!clientId) continue; // absolute last resort skip
      }

      const dateVal = getField(r, keyMap, "Date", "date");
      const parsedDate = parseDate(dateVal);
      const dateKey = parsedDate ? parsedDate.toISOString().slice(0, 10) : "no-date";
      const legacyNumber = getField(r, keyMap, "Estimate #", "number", "Number");
      // Make each row's number unique within the batch to avoid MongoDB unique constraint errors.
      // If a legacyNumber is reused across multiple rows in the file, append a suffix.
      const rawNumber = legacyNumber || `EST-${baseTs}-${i}`;
      const groupKey = legacyNumber ? `num:${legacyNumber}` : `grp:${companyName}|${dateKey}|${groupCounter++}`;
      // Ensure the stored number is unique: if this group key is new, use rawNumber;
      // if it already exists (same Estimate # repeated for multiple items), we reuse the group.
      const number = groups.has(groupKey) ? groups.get(groupKey).number : rawNumber;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          client: clientId,
          connectPerson: getField(r, keyMap, "Connect Person", "connectPerson") || "",
          phone: getField(r, keyMap, "Phone Number", "phone") || "",
          mailId: getField(r, keyMap, "Mail Id", "mailId") || "",
          salesPerson: getField(r, keyMap, "Sales Person", "salesPerson") || "",
          branch: getField(r, keyMap, "Branch", "branch") || "",
          date: parsedDate || new Date(),
          expirydate: (() => {
            const v = getField(r, keyMap, "expirydate", "Open Till", "open_till");
            return v ? (parseDate(v) || undefined) : undefined;
          })(),
          status: normalizeStatus(getField(r, keyMap, "Status", "status")),
          notes: getField(r, keyMap, "Subject", "subject") || "",
          number,
          items: [],
        });
      }

      const group = groups.get(groupKey);
      const itemDescription = getField(r, keyMap, "Item", "item", "description") || "";
      const qty = getField(r, keyMap, "Quantity", "quantity", "qty") ?? 1;
      const rate = getField(r, keyMap, "Rate", "rate") ?? 0;
      const amount = getField(r, keyMap, "Amount", "amount");
      if (itemDescription || rate || qty) {
        group.items.push({
          description: itemDescription || "Imported Item",
          qty: toNumber(qty) || 1,
          rate: toNumber(rate),
          amount: amount !== undefined ? toNumber(amount) : toNumber(qty) * toNumber(rate),
        });
      }
    }

    const rows = [...groups.values()].map((group) => {
      const total = group.items.reduce((sum, it) => sum + (it.amount || it.qty * it.rate), 0);
      return {
        client: group.client,
        connectPerson: group.connectPerson,
        phone: group.phone,
        mailId: group.mailId,
        salesPerson: group.salesPerson,
        branch: group.branch,
        notes: group.notes,
        total,
        subtotal: total,
        number: group.number,
        date: group.date,
        expirydate: group.expirydate,
        status: group.status,
        tenant_id: tenantId,
        created_by: req.user?._id,
        items: group.items.length ? group.items : [{ description: "Imported Estimate", rate: 0, qty: 1, amount: 0 }],
      };
    });

    if (rows.length === 0) {
      return res.status(400).json({
        message: "No importable rows. Make sure your file has a Company Name column and valid data.",
      });
    }

    // ── Deduplication: skip estimates whose number already exists in DB ───────
    // Only deduplicate on real Estimate # values (not auto-generated ones)
    const realNumbers = rows.map(r => r.number).filter(n => n && !n.startsWith("EST-"));
    const existingDocs = realNumbers.length
      ? await Estimate.find({ number: { $in: realNumbers }, ...tenantFilter }).select("number").lean()
      : [];
    const existingSet = new Set(existingDocs.map(e => e.number));

    const toInsert = rows.filter(r => !existingSet.has(r.number));
    const skippedDuplicates = rows.length - toInsert.length;

    console.log("[importEstimates] to insert:", toInsert.length, "| skipped duplicates:", skippedDuplicates);

    if (toInsert.length === 0) {
      return res.status(200).json({
        message: `All ${rows.length} estimate(s) already exist in the database — nothing imported.`,
        count: 0,
        skipped: skippedDuplicates,
      });
    }

    const result = await Estimate.insertMany(toInsert, { ordered: false });
    console.log("[importEstimates] inserted:", result.length);
    res.status(201).json({
      message: `Imported ${result.length} estimate(s).${skippedDuplicates ? ` Skipped ${skippedDuplicates} duplicate(s).` : ""}`,
      count: result.length,
      skipped: skippedDuplicates,
    });
  } catch (error) {
    console.error("IMPORT ESTIMATES ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// estimate from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large estimate lists.
const bulkDeleteEstimates = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No estimate ids provided" });

    const query = { _id: { $in: ids }, ...estimateScope(req) };

    const matched = await Estimate.find(query).select("_id number date tenant_id").lean();
    let deletable = matched;
    // "Delete estimate allowed only on last estimate": only the newest one may go.
    const tenantForRules = req.user?.is_superadmin ? null : req.user?.tenant_id;
    const cfg = await docSettings.getDocSettings("estimate", tenantForRules);
    if (cfg.deleteOnlyLast) {
      const last = await Estimate.findOne({ tenant_id: tenantForRules ?? null }).sort({ createdAt: -1 }).select("_id");
      deletable = matched.filter((m) => last && String(m._id) === String(last._id));
    }
    const notLastSkipped = matched.length - deletable.length;
    const matchedIds = deletable.map((m) => m._id);

    const result = matchedIds.length
      ? await Estimate.deleteMany({ _id: { $in: matchedIds } })
      : { deletedCount: 0 };
    await CustomFieldService.deleteValuesForMany(matchedIds, "estimate");
    for (const doc of deletable) await docSettings.releaseNumberOnDelete("estimate", doc.tenant_id, doc);

    logActivity(req, `Bulk-deleted ${result.deletedCount} estimate(s)`, { rel_type: "estimate" });
    const skippedNote = notLastSkipped
      ? ` — ${notLastSkipped} skipped: only the most recent estimate can be deleted (Setup > Settings > Estimates)`
      : "";
    res.json({ message: `Deleted ${result.deletedCount} estimate(s)${skippedNote}`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getEstimates, getEstimateById, createEstimate, updateEstimate, deleteEstimate, convertToInvoice, importEstimates, bulkDeleteEstimates };
