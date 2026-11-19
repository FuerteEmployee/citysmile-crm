const Purchase = require("../models/Purchase");
const Vendor = require("../models/Vendor");
const { logActivity } = require("../services/ActivityLogService");
const { isFeatureEnabled } = require("../utils/featureFlags");
const { stateNameFromGstin } = require("../utils/gstStateCodes");
const gstService = require("../services/gstService");
const {
  HOME_STATE,
  HOME_STATE_GST_CODE,
  detectStateFromAddress,
} = require("../utils/gstHomeState");

const VENDOR_LINKAGE_FLAG = "vendor_linked_purchases";

// When vendor-linked purchases is on for this tenant, a vendor is required
// and its fields are snapshotted onto the purchase (supplier_* stays the
// snapshot going forward — editing the Vendor later never touches old bills).
const applyVendorSnapshot = async (data, tenantId) => {
  if (!data.vendor_id) return data;
  const vendor = await Vendor.findOne({ _id: data.vendor_id, tenant_id: tenantId });
  if (!vendor) throw new Error("Selected vendor was not found");

  data.supplier_name = vendor.company_name;
  data.supplier_gstin = vendor.gst_number || "";
  data.supplier_address = vendor.address || "";
  data.supplier_state = stateNameFromGstin(vendor.gst_number) || data.supplier_state || HOME_STATE;
  return data;
};

// Normalizes the date formats that arrive from Excel imports and forms:
// "15-05-2026" / "15/05/2026" (Indian day-first), "2026-05-15" (ISO),
// Excel serial numbers (e.g. 46157), Date objects, or empty → null.
const parseDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  // Excel serial date number (days since 1899-12-30)
  if (typeof value === "number" || /^\d{5}(\.\d+)?$/.test(String(value).trim())) {
    const serial = Number(value);
    if (serial > 25569 && serial < 80000) {
      return new Date(Math.round((serial - 25569) * 86400 * 1000));
    }
  }

  const str = String(value).trim();

  // Day-first: DD-MM-YYYY or DD/MM/YYYY (Indian bill format)
  const dayFirst = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dayFirst) {
    const [, d, m, y] = dayFirst;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return isNaN(date.getTime()) ? null : date;
  }

  // Year-first: YYYY-MM-DD or anything else JS can parse (ISO, "May 15 2026", …)
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
};

const resolveIsHomeState = (data) => {
  const gstin = String(data.supplier_gstin || "").trim();
  if (/^\d{2}/.test(gstin)) {
    return gstin.substring(0, 2) === HOME_STATE_GST_CODE;
  }
  return String(data.supplier_state || "").trim().toLowerCase() === HOME_STATE;
};

// Multi-item bill: one Purchase document holds several product lines (the
// manual "New Purchase" form's items table). Each line's taxable value is
// its own price + freight, taxed at its own GST rate, split the same way as
// single-item bills (state decided once per document). The flat top-level
// fields (product/quantity/rate/amount/freight_charge/gst_rate/cgst/sgst/
// igst/total) are then set to bill-level rollups computed from the items —
// every report/list/vendor-view that only reads those flat fields (never
// per-item detail) keeps working unchanged.
const applyMultiItemTaxLogic = (data) => {
  const isHomeState = resolveIsHomeState(data);
  data.tax_type = isHomeState ? "GST" : "IGST";

  const gstLines = [];
  const gstRatesSeen = new Set();
  const productNames = [];
  let totalQty = 0;
  let totalFreight = 0;

  data.items = data.items.map((raw) => {
    const qty = Number(raw.quantity ?? raw.qty) || 0;
    const rate = Number(raw.rate) || 0;
    let itemAmount = Number(raw.amount) || 0;
    if (!itemAmount && qty && rate) itemAmount = gstService.round2(qty * rate);
    const itemFreight = Number(raw.freight_charge) || 0;
    const gstRate = Number(raw.gst_rate) || 0;

    // Taxable value = price + freight, same rule as a single-item bill.
    const line = gstService.calculateLine({ qty: 1, rate: itemAmount + itemFreight, gstRate });
    const split = gstService.splitTax({
      gstAmount: line.gstAmount,
      companyStateCode: HOME_STATE_GST_CODE,
      placeOfSupplyStateCode: isHomeState ? HOME_STATE_GST_CODE : "00",
    });

    gstLines.push({ taxableValue: line.taxableValue, ...split });
    totalQty += qty;
    totalFreight += itemFreight;
    gstRatesSeen.add(gstRate);
    if (raw.product) productNames.push(raw.product);

    return {
      item_id: raw.item_id || null,
      product: raw.product || "",
      hsn_code: raw.hsn_code || "",
      quantity: qty,
      rate,
      amount: itemAmount,
      freight_charge: itemFreight,
      gst_rate: gstRate,
      cgst: split.cgst,
      sgst: split.sgst,
      igst: split.igst,
      total: gstService.round2(line.taxableValue + line.gstAmount),
    };
  });

  const docTotals = gstService.calculateDocumentTotals(gstLines);

  data.quantity = totalQty;
  data.rate = data.items.length === 1 ? data.items[0].rate : 0;
  data.amount = gstService.round2(data.items.reduce((sum, i) => sum + i.amount, 0));
  data.freight_charge = gstService.round2(totalFreight);
  data.gst_rate = gstRatesSeen.size === 1 ? [...gstRatesSeen][0] : 0;
  data.product = productNames.length ? productNames.join(", ") : (data.product || "");
  data.hsn_code = data.items.length === 1 ? data.items[0].hsn_code : "";
  data.cgst = docTotals.total_cgst;
  data.sgst = docTotals.total_sgst;
  data.igst = docTotals.total_igst;
  data.round_off = docTotals.round_off;
  data.total = docTotals.payable;

  return data;
};

// Decides GST (intra-state) vs IGST (inter-state) and computes a single-line
// bill: Price = quantity × rate (unless an explicit amount is given), taxable
// value includes freight, tax splits by state, grand total is rounded with
// round-off. State priority: GSTIN code (first 2 digits) > supplier_state >
// state found in address.
const applySingleItemTaxLogic = (data, isPilot = false, { trustSuppliedSplit = false } = {}) => {
  const quantity = Number(data.quantity) || 0;
  const rate = Number(data.rate) || 0;
  let amount = Number(data.amount) || 0;
  if (!amount && quantity && rate) amount = Math.round(quantity * rate * 100) / 100;
  data.amount = amount;

  let freight = Number(data.freight_charge);
  if (isNaN(freight)) freight = 0;
  if (isPilot && freight === 0 && data.freight_charge === undefined) {
    freight = Math.round(amount * 0.01 * 100) / 100;
  }
  data.freight_charge = freight;

  const suppliedCgst = Number(data.cgst) || 0;
  const suppliedSgst = Number(data.sgst) || 0;
  const suppliedIgst = Number(data.igst) || 0;
  // Import rows from Tally-style purchase registers already carry a computed,
  // authoritative CGST/SGST/IGST split from the source accounting system. Trust
  // it instead of re-deriving from supplier_state, which imports never set —
  // re-deriving would silently force every imported bill to inter-state/IGST.
  // Manual create/update never pass a split (trustSuppliedSplit defaults off),
  // so this only changes behavior for importPurchases.
  const hasSuppliedSplit = trustSuppliedSplit && (suppliedCgst > 0 || suppliedSgst > 0 || suppliedIgst > 0);

  let gstRate = Number(data.gst_rate) || 0;
  if (!gstRate) {
    const totalTax = suppliedCgst + suppliedSgst + suppliedIgst;
    const taxable = amount + freight;
    if (totalTax > 0 && taxable > 0) {
      gstRate = Math.round((totalTax / taxable) * 100);
    }
  }
  data.gst_rate = gstRate;

  if (!String(data.supplier_state || "").trim() && data.supplier_address) {
    const detected = detectStateFromAddress(data.supplier_address);
    if (detected) data.supplier_state = detected;
  }

  if (hasSuppliedSplit) {
    data.tax_type = suppliedIgst > 0 ? "IGST" : "GST";
    data.cgst = gstService.round2(suppliedCgst);
    data.sgst = gstService.round2(suppliedSgst);
    data.igst = gstService.round2(suppliedIgst);

    const taxableValue = gstService.round2(amount + freight);
    const totals = gstService.calculateDocumentTotals([
      { taxableValue, cgst: data.cgst, sgst: data.sgst, igst: data.igst },
    ]);
    data.round_off = totals.round_off;
    data.total = totals.payable;
  } else {
    let isHomeState;
    const gstin = String(data.supplier_gstin || "").trim();
    if (/^\d{2}/.test(gstin)) {
      isHomeState = gstin.substring(0, 2) === HOME_STATE_GST_CODE;
    } else {
      isHomeState = String(data.supplier_state || "").trim().toLowerCase() === HOME_STATE;
    }

    // Purchases has one effective line per bill: taxable value = price + freight.
    // All the actual math (line rounding, CGST/SGST vs IGST split, grand total,
    // round-off) comes from the single shared GST service — see services/gstService.js.
    const line = gstService.calculateLine({ qty: 1, rate: amount + freight, gstRate });
    const split = gstService.splitTax({
      gstAmount: line.gstAmount,
      companyStateCode: HOME_STATE_GST_CODE,
      placeOfSupplyStateCode: isHomeState ? HOME_STATE_GST_CODE : "00", // any non-home code forces IGST
    });

    data.tax_type = isHomeState ? "GST" : "IGST";
    data.cgst = split.cgst;
    data.sgst = split.sgst;
    data.igst = split.igst;

    const totals = gstService.calculateDocumentTotals([{ taxableValue: line.taxableValue, ...split }]);
    data.round_off = totals.round_off;
    data.total = totals.payable;
  }

  return data;
};

// Entry point used by createPurchase/updatePurchase/importPurchases. Branches
// on whether the payload carries an `items` array (the manual "New Purchase"
// form's multi-product mode) or the legacy flat single-line shape (imports,
// and any older caller) — either way, date fields get normalized the same way.
const applyTaxLogic = (data, isPilot = false, opts = {}) => {
  if (Array.isArray(data.items) && data.items.length > 0) {
    applyMultiItemTaxLogic(data);
  } else {
    applySingleItemTaxLogic(data, isPilot, opts);
  }

  // Normalize every date field — Excel imports arrive as "15-05-2026",
  // Excel serial numbers, or ISO strings; Mongoose only accepts real dates.
  if ("bill_date" in data) {
    const parsed = parseDate(data.bill_date);
    if (parsed) data.bill_date = parsed;
    else delete data.bill_date; // let the schema default (today) apply
  }
  if ("due_date" in data) data.due_date = parseDate(data.due_date);
  if ("payment_date" in data) data.payment_date = parseDate(data.payment_date);

  // Payment date implies the bill is paid (used by Excel import)
  if (data.payment_date && !data.payment_status) {
    data.payment_status = "Paid";
  }

  return data;
};

const getPurchases = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const { page, limit, search, branch, vendor, type, procurementType, categoryId, subcategoryId, locationId } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (exports, dashboard aggregation) keep getting the full bare array.
    if (!isPaginated) {
      const purchases = await Purchase.find(filter).sort({ createdAt: -1 });
      return res.json(purchases);
    }

    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const andConditions = [];

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      andConditions.push({
        $or: [
          { bill_no: re },
          { supplier_name: re },
          { supplier_state: re },
          { supplier_gstin: re },
          { product: re },
          { hsn_code: re },
          { sales_person: re },
          { branch: re },
          { voucher_type: re },
        ],
      });
    }
    if (branch) filter.branch = branch;

    const pType = type || procurementType;
    if (pType && String(pType).toUpperCase() !== "ALL") {
      andConditions.push({
        $or: [
          { procurementType: String(pType).toUpperCase() },
          { "items.procurementType": String(pType).toUpperCase() },
        ],
      });
    }

    if (categoryId) {
      andConditions.push({
        $or: [
          { categoryId: categoryId },
          { "items.categoryId": categoryId },
        ],
      });
    }

    if (subcategoryId) {
      andConditions.push({
        $or: [
          { subcategoryId: subcategoryId },
          { "items.subcategoryId": subcategoryId },
        ],
      });
    }

    if (locationId) {
      andConditions.push({
        $or: [
          { locationId: locationId },
          { "items.locationId": locationId },
        ],
      });
    }
    // `vendor` may be a comma-separated list of vendor ids from the
    // multi-select filter. Purchase.vendor_id is only reliably set on bills
    // created while vendor-linked purchases was on, so imported/free-text
    // bills are matched the same way the old client-side filter did: by
    // the selected vendors' GSTIN or company name against supplier_* text.
    if (vendor) {
      const vendorIds = String(vendor).split(",").filter(Boolean);
      if (vendorIds.length) {
        const vendorDocs = await Vendor.find({ _id: { $in: vendorIds } }).select("company_name gst_number");
        const gstins = vendorDocs.map((v) => (v.gst_number || "").trim()).filter(Boolean);
        const nameRes = vendorDocs
          .map((v) => (v.company_name || "").trim())
          .filter(Boolean)
          .map((name) => new RegExp(escapeRegExp(name), "i"));
        andConditions.push({
          $or: [
            { vendor_id: { $in: vendorIds } },
            ...(gstins.length ? [{ supplier_gstin: { $in: gstins } }] : []),
            ...(nameRes.length ? [{ supplier_name: { $in: nameRes } }] : []),
          ],
        });
      }
    }
    if (andConditions.length) filter.$and = andConditions;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    // Summary cards (Taxable Amount / CGST / SGST / IGST / Grand Total) show
    // totals for the currently filtered view, not just the loaded page.
    const [total, totalsAgg, purchases] = await Promise.all([
      Purchase.countDocuments(filter),
      Purchase.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            amount: { $sum: "$amount" },
            cgst: { $sum: "$cgst" },
            sgst: { $sum: "$sgst" },
            igst: { $sum: "$igst" },
            total: { $sum: "$total" },
          },
        },
      ]),
      Purchase.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    const t = totalsAgg[0] || {};
    res.json({
      data: purchases,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      totals: {
        amount: t.amount || 0,
        cgst: t.cgst || 0,
        sgst: t.sgst || 0,
        igst: t.igst || 0,
        total: t.total || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Distinct branch values actually stored on purchase bills — see the same
// fix on invoices: the Branch filter dropdown only ever listed the separate
// HRMS branch master, so an imported free-text branch name could never be
// selected there even though it displays fine in the table.
const getPurchaseBranches = async (req, res) => {
  try {
    const query = {};
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    const branches = await Purchase.distinct("branch", { ...query, branch: { $nin: [null, ""] } });
    res.json(branches.sort());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPurchaseById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;
    const purchase = await Purchase.findOne(query);
    if (!purchase) return res.status(404).json({ message: "Purchase not found" });
    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createPurchase = async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id;
    const vendorLinkageOn = await isFeatureEnabled(tenantId, VENDOR_LINKAGE_FLAG);

    if (vendorLinkageOn && !req.body.vendor_id) {
      return res.status(400).json({ message: "A vendor is required for this purchase bill" });
    }

    let data = { ...req.body };
    if (vendorLinkageOn) data = await applyVendorSnapshot(data, tenantId);
    else delete data.vendor_id; // ignore stray vendor_id when the flag is off for this tenant
    // The "Pick from catalog" field is optional — leaving it blank sends "",
    // and Mongoose throws a BSONError trying to cast "" to an ObjectId.
    if (data.item_id === "") delete data.item_id;

    const { isTrinetraPilotUser } = require("../middleware/auth");
    const isPilot = isTrinetraPilotUser(req.user);
    data = applyTaxLogic(data, isPilot);
    if (req.user && req.user._id) data.created_by = req.user._id;

    const purchase = await Purchase.create({ ...data, tenant_id: tenantId });
    logActivity(req, `Created purchase bill: ${purchase.bill_no}`, { rel_id: purchase._id, rel_type: "purchase" });
    res.status(201).json(purchase);
  } catch (error) {
    console.error("Purchase Creation Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const updatePurchase = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const purchase = await Purchase.findOne(query);
    if (!purchase) return res.status(404).json({ message: "Purchase not found" });

    const tenantId = req.user?.tenant_id ?? purchase.tenant_id;
    const vendorLinkageOn = await isFeatureEnabled(tenantId, VENDOR_LINKAGE_FLAG);

    let incoming = { ...req.body };
    if (vendorLinkageOn && incoming.vendor_id) {
      incoming = await applyVendorSnapshot(incoming, tenantId);
    } else if (!vendorLinkageOn) {
      delete incoming.vendor_id;
    }
    // Same as createPurchase — an unpicked catalog item arrives as "", which
    // Mongoose can't cast to an ObjectId.
    if (incoming.item_id === "") delete incoming.item_id;

    const { isTrinetraPilotUser } = require("../middleware/auth");
    const isPilot = isTrinetraPilotUser(req.user);
    // Recompute the tax split with merged values so a state/amount change updates GST/IGST
    const merged = applyTaxLogic({
      ...purchase.toObject(),
      ...incoming,
    }, isPilot);
    delete merged._id;

    Object.assign(purchase, merged);
    const updated = await purchase.save();
    logActivity(req, `Updated purchase bill: ${updated.bill_no}`, { rel_id: updated._id, rel_type: "purchase" });
    res.json(updated);
  } catch (error) {
    console.error("Purchase Update Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const deletePurchase = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const purchase = await Purchase.findOne(query);
    if (!purchase) return res.status(404).json({ message: "Purchase not found" });

    await purchase.deleteOne();
    logActivity(req, `Deleted purchase bill: ${purchase.bill_no}`, { rel_id: purchase._id, rel_type: "purchase" });
    res.json({ message: "Purchase removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces the frontend's old pattern of firing
// one DELETE per selected row (Promise.all over hundreds/thousands of ids),
// which overwhelmed the browser's per-host connection limit and the dev
// server under Mass Delete and surfaced as a generic "Failed to fetch".
const bulkDeletePurchases = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No purchase bill ids provided" });

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const result = await Purchase.deleteMany(query);
    logActivity(req, `Bulk-deleted ${result.deletedCount} purchase bill(s)`, { rel_type: "purchase" });
    res.json({ message: `Deleted ${result.deletedCount} purchase bill(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const importPurchases = async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    if (rows.length === 0) {
      return res.status(400).json({ message: "No purchase rows received", count: 0 });
    }

    const tenantId = req.user?.tenant_id;
    const docs = [];
    const errors = [];

    const { isTrinetraPilotUser } = require("../middleware/auth");
    const isPilot = isTrinetraPilotUser(req.user);

    rows.forEach((row, i) => {
      const hasValue = Number(row.amount) > 0 || (Number(row.quantity) > 0 && Number(row.rate) > 0);
      if (!row.bill_no || !row.supplier_name || !hasValue) {
        const reason = `Row ${i + 1}: Bill Reference, Company Name and Price (or Quantity × Rate) are required`;
        errors.push(reason);
        console.warn(`[importPurchases] skipped — ${reason}`);
        return;
      }
      const data = applyTaxLogic({ ...row }, isPilot, { trustSuppliedSplit: true });
      docs.push({
        ...data,
        created_by: req.user?._id,
        tenant_id: tenantId,
      });
    });

    let created = [];
    if (docs.length > 0) {
      try {
        // ordered:false so one malformed row can't abort the whole batch —
        // every other valid row still gets inserted.
        created = await Purchase.insertMany(docs, { ordered: false });
      } catch (bulkErr) {
        created = bulkErr.insertedDocs || [];
        const writeErrors = bulkErr.writeErrors || [];
        writeErrors.forEach((we) => {
          const failedDoc = docs[we.index];
          const reason = `Bill "${failedDoc?.bill_no || "?"}" failed to insert: ${we.errmsg || we.err?.errmsg || "unknown error"}`;
          errors.push(reason);
          console.error(`[importPurchases] ${reason}`);
        });
        if (!writeErrors.length) console.error("[importPurchases] bulk insert error:", bulkErr.message);
      }
      logActivity(req, `Imported ${created.length} purchase bills`, { rel_type: "purchase" });
    }

    console.log(`[importPurchases] rows received: ${rows.length} | inserted: ${created.length} | skipped/failed: ${errors.length}`);

    res.status(201).json({
      count: created.length,
      message: `Imported ${created.length} of ${rows.length} purchase bills${errors.length ? `. Skipped: ${errors.join("; ")}` : ""}`,
    });
  } catch (error) {
    console.error("Purchase Import Error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Same one-request rationale as bulkDeletePurchases, for the Bulk Actions
// "update Payment Status/Date/Method for N selected bills" path.
const bulkUpdatePurchases = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const updates = req.body?.updates || {};
    if (ids.length === 0) return res.status(400).json({ message: "No purchase bill ids provided" });
    if (Object.keys(updates).length === 0) return res.status(400).json({ message: "No fields to update" });

    const allowed = ["payment_status", "payment_date", "paymentmode"];
    const setFields = {};
    for (const key of allowed) if (key in updates) setFields[key] = updates[key];

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;

    const result = await Purchase.updateMany(query, { $set: setFields });
    logActivity(req, `Bulk-updated ${result.modifiedCount} purchase bill(s)`, { rel_type: "purchase" });
    res.json({ message: `Updated ${result.modifiedCount} purchase bill(s)`, modifiedCount: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  deletePurchase,
  bulkDeletePurchases,
  bulkUpdatePurchases,
  importPurchases,
  applyTaxLogic,
  getPurchaseBranches,
};
