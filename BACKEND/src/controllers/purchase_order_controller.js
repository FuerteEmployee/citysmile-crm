const mongoose = require("mongoose");
const PurchaseOrder = require("../models/PurchaseOrder");
const PoSettings = require("../models/PoSettings");
const PoItem = require("../models/PoItem");
const Client = require("../models/Client");
const ActivityLog = require("../models/ActivityLog");
const { hasCapability } = require("../middleware/auth");
const { evaluatePo, floorError, round2, costOf, fyOf, formatPoNumber } = require("../services/purchaseOrderRules");
const V = require("../services/poValidation");
const ACT = require("../services/poActions");

const { DEFAULT_PO_SETTINGS, DEFAULT_FORMAT, PRICE_FIELDS } = PoSettings;

// Everything here sits behind requireTenantFeature("purchase_orders") and
// checkPermission("Purchase Orders") — see purchase_order_routes.js.
const MODULE = "Purchase Orders";
const can = (req, cap) => hasCapability(req, MODULE, cap);

// Statuses a PO can move to by hand, from each status. Approval moves
// (draft -> pending_approval/approved, pending -> approved/draft) only happen
// through submit/approve/reject.
const STATUS_MOVES = {
  draft: ["cancelled"],
  pending_approval: ["cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  // partially_received → partially_received records a later delivery.
  partially_received: ["partially_received", "received", "cancelled"],
  received: [],
  cancelled: [],
};
const SENDABLE = ["approved", "sent", "partially_received", "received"];
const ALL_PRICE_FIELDS = ["master_price", "cost_price", "distributor_price", "end_customer_price"];

// extra (round 29): { field } = the form field the message belongs to (the
// editor shows it under that field); { code, existing } for answers the UI
// acts on (e.g. a duplicate customer PO with a link to the other PO).
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra ? { details: extra } : {});
const fail = (res, error) => {
  // Two people acting on the same PO at once (e.g. Yes and No together):
  // the second save loses (optimisticConcurrency on the model).
  if (error.name === "VersionError") {
    return res.status(409).json({ message: "Someone else changed this PO just now. Reload it and try again." });
  }
  return res.status(error.status || 500).json({ message: error.message, ...(error.details || {}) });
};
// A validator result ({ value } | { error }) → the value, or a 400 for `field`.
const check = (result, field) => {
  if (result.error) throw httpError(400, result.error, field ? { field } : undefined);
  return result.value;
};
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const staffName = (s) => [s?.firstname, s?.lastname].filter(Boolean).join(" ") || s?.email || "Someone";
const plain = (doc) => (doc?.toObject ? doc.toObject() : doc);

const tenantOf = (req) => {
  if (!req.user?.tenant_id) throw httpError(400, "Your account is not linked to a company");
  return req.user.tenant_id;
};

// Staff with "View (Own)" see only their own POs; approvers see every PO so
// they can decide on them.
const scopeFilter = async (req) => {
  const filter = { tenant_id: tenantOf(req) };
  if (req.permissionLevel === "own" && !(await can(req, "Approve"))) filter.created_by = req.user._id;
  return filter;
};

const loadPo = async (req, id) => {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, "Purchase order not found");
  const po = await PurchaseOrder.findOne({ _id: id, ...(await scopeFilter(req)) });
  if (!po) throw httpError(404, "Purchase order not found");
  return po;
};

// ─── Settings ──────────────────────────────────────────────────────────────

const getSettingsDoc = async (tenantId) => {
  let settings = await PoSettings.findOne({ tenant_id: tenantId });
  if (settings) return settings;
  try {
    settings = await PoSettings.create({
      tenant_id: tenantId,
      ...DEFAULT_PO_SETTINGS,
      format_history: [{ version: 1, format: DEFAULT_FORMAT, saved_at: new Date() }],
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    settings = await PoSettings.findOne({ tenant_id: tenantId }); // created by a parallel request
  }
  return settings;
};

const formatForVersion = (settings, version) =>
  settings.format_history.find((h) => h.version === version)?.format || settings.format || DEFAULT_FORMAT;

// R2: "<prefix>/<running no.>/<FY>" like the client's PO format (DA/07/26-27).
// Counted per division and financial year (April–March, restarts each FY).
// Only Purchase POs get new numbers (Sales PO was removed).
const nextNumber = async (settings, division, date) => {
  const fy = fyOf(date);
  if (!fy) throw httpError(400, "PO date is not a valid date");
  const key = `${division}_purchase_${fy}`;
  const updated = await PoSettings.findOneAndUpdate(
    { _id: settings._id },
    { $inc: { [`counters.${key}`]: 1 } },
    { new: true }
  );
  const div = settings.divisions.find((d) => d.key === division);
  return { po_number: formatPoNumber(div.purchase_prefix, updated.counters.get(key), fy), fy };
};

// ─── Company details (Q4) ──────────────────────────────────────────────────

const COMPANY_FIELDS = [
  "name", "line2", "address", "gstin", "state", "phone", "email", "logo_url",
  "bank_account_name", "bank_name_branch", "bank_account_no", "bank_ifsc",
  "po_terms", "payment_terms", "delivery_terms",
];

// The CRM company profile (Setup > Settings > Company) of this tenant.
const crmCompanyProfile = async (tenantId) => {
  const Setting = require("../models/Setting");
  const names = ["companyName", "compAddress", "compCity", "compState", "compZip", "compPhone", "compEmail", "compVat", "compLogoLight"];
  const rows = await Setting.find({ tenant_id: tenantId, name: { $in: names } }).select("name value").lean();
  const v = Object.fromEntries(rows.map((r) => [r.name, typeof r.value === "string" ? r.value.trim() : ""]));
  return {
    name: v.companyName || "",
    address: [v.compAddress, v.compCity, v.compState, v.compZip].filter(Boolean).join(", "),
    gstin: v.compVat || "",
    state: v.compState || "",
    phone: v.compPhone || "",
    email: v.compEmail || "",
    logo_url: v.compLogoLight || "",
  };
};

// What the PDFs print as the company's own block: the saved PO Settings
// company details; until an admin saves them, prefilled from the CRM profile.
const effectiveCompany = async (settings) => {
  const saved = plain(settings).company || {};
  const out = Object.fromEntries(COMPANY_FIELDS.map((k) => [k, saved[k] || ""]));
  if (saved.saved_at) return { ...out, saved_at: saved.saved_at };
  const profile = await crmCompanyProfile(settings.tenant_id);
  Object.entries(profile).forEach(([k, val]) => { if (!out[k] && val) out[k] = val; });
  return { ...out, prefilled: true };
};

// Q2: the customer's price level (selling-price floor): end_user / distributor.
const priceLevelOf = (settings, customerId) => {
  if (!customerId) return "end_user";
  const levels = settings.customer_price_levels;
  const level = levels?.get ? levels.get(String(customerId)) : levels?.[String(customerId)];
  return level === "distributor" ? "distributor" : "end_user";
};

// The Purchase PO rule: the saved one with the floor always on (R6), the
// floor price taken from the customer's price level.
const purchaseRule = (settings, level = "end_user") => {
  const saved = plain(settings).rules?.purchase || {};
  return {
    ...saved,
    price_floor: true,
    list_price_field: level === "distributor" ? "distributor_price" : saved.list_price_field || "end_customer_price",
  };
};

// Old Sales POs (before R1) open read-only; nothing can change them.
const assertNotSales = (po) => {
  if (po.type === "sales") throw httpError(400, "Old Sales POs are read-only (Sales PO was removed)");
};

// ─── Shared PO building ────────────────────────────────────────────────────

const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? undefined : Number(v));

// A typed line amount. Missing (undefined / null) = use the default; anything
// sent must be a number from 0 to max — a cleared box or text is an error, so
// the server never prices a line differently from what the editor showed.
const lineAmount = (v, label, max = Infinity) => {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw httpError(400, `${label}: enter a number`);
  if (n < 0) throw httpError(400, `${label} can't be negative`);
  if (n > max) throw httpError(400, `${label} can't be more than ${max}`);
  return n;
};

// Turns the posted lines into priced lines. Items come only from the PO
// module's own list (PoItem — never the CRM Items module). Cost and list
// price always come from its price master, never from the request; only qty,
// selling price and GST % are the user's. A line whose item has since been
// deleted (or an old line from before PO Items existed) keeps the copy it
// already has on this PO.
// S4: the same item twice on one PO is merged into the first line (qty
// added; that line's selling price / GST % kept) with a warning. Each qty is
// checked first (whole number 1 to 1,00,000), and so is the merged total.
const mergeSameItems = (inputLines, warnings) => {
  const out = [];
  inputLines.forEach((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw httpError(400, `Line ${i + 1}: not an item line`, { field: "items" });
    const qty = check(V.quantity(l.qty, { label: `Line ${i + 1}: quantity` }), "items");
    // Typed amounts are checked on every line, also on one that gets merged.
    if (l.selling_price !== undefined && l.selling_price !== null) check(V.price(l.selling_price, { label: `Line ${i + 1}: selling price` }), "items");
    lineAmount(l.tax_rate, `Line ${i + 1}: GST %`, 100);
    const key = l.item_id ? String(l.item_id) : null;
    const first = key && out.find((x) => x.key === key);
    if (first) {
      first.line.qty += qty;
      first.merged = true;
      return;
    }
    out.push({ key, line: { ...l, qty }, index: i });
  });
  out.filter((x) => x.merged).forEach((x) => {
    check(V.quantity(x.line.qty, { label: `Line ${x.index + 1}: quantity` }), "items");
    warnings.push(`The same item was on the PO more than once — merged into line ${out.indexOf(x) + 1} (qty ${x.line.qty})`);
  });
  return out.map((x) => x.line);
};

const buildLines = async (req, rawLines, rule, existingLines = [], warnings = []) => {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw httpError(400, "Add at least one item", { field: "items" });
  if (rawLines.length > 500) throw httpError(400, "At most 500 items on one PO", { field: "items" });
  const inputLines = mergeSameItems(rawLines, warnings);
  const tenantId = tenantOf(req);
  const ids = inputLines.map((l) => l.item_id).filter((id) => mongoose.isValidObjectId(id));
  const items = await PoItem.find({ _id: { $in: ids }, tenant_id: tenantId }).lean();
  const byId = new Map(items.map((i) => [String(i._id), i]));

  return inputLines.map((l, i) => {
    const item = byId.get(String(l.item_id));
    const prev = existingLines.find((p) => p.item_id && String(p.item_id) === String(l.item_id));
    if (!item && !prev) throw httpError(400, `Line ${i + 1}: pick the item from the PO items`, { field: "items" });
    // A switched-off item can stay on a PO that already has it, but not be added.
    if (item && item.active === false && !prev) throw httpError(400, `Line ${i + 1}: ${item.name} is switched off in PO Items`, { field: "items" });
    const qty = l.qty;

    // Q1: cost = Master Distributor Price, else Distributor Price (flagged).
    const base = item
      ? {
          item_id: item._id,
          item_code: item.item_code || "",
          y_code: item.y_code || "",
          name: item.name,
          description: item.description || "",
          hsn: item.hsn || "",
          unit: item.unit || "",
          ...costOf(item),
          list_price: item[rule.list_price_field] || 0,
        }
      : {
          item_id: prev.item_id,
          item_code: prev.item_code,
          y_code: prev.y_code,
          name: prev.name,
          description: prev.description,
          hsn: prev.hsn,
          unit: prev.unit,
          cost_price: prev.cost_price,
          cost_source: prev.cost_source,
          list_price: prev.list_price,
        };
    if (item?.replaced_by && !prev) {
      warnings.push(`Line ${i + 1}: ${item.item_code || item.name} is obsolete — replaced by ${item.replaced_by}`);
    }
    const itemTax = item?.tax_rate || 0;
    // Selling price: missing (undefined / null) = the floor price; a
    // cleared box / text / negative / > 1,00,00,000 / 3+ decimals = 400.
    const selling = l.selling_price === undefined || l.selling_price === null ? undefined : check(V.price(l.selling_price, { label: `Line ${i + 1}: selling price` }), "items");
    const taxRate = lineAmount(l.tax_rate, `Line ${i + 1}: GST %`, 100);
    const gstNote = V.gstWarning(taxRate ?? prev?.tax_rate ?? itemTax, `Line ${i + 1}: GST %`);
    if (gstNote) warnings.push(gstNote);
    const line = {
      ...base,
      qty,
      qty_received: Math.min(prev?.qty_received || 0, qty),
      selling_price: selling ?? base.list_price,
      tax_rate: taxRate ?? prev?.tax_rate ?? itemTax,
    };
    // Price only up: checked against today's master on create, edit and submit.
    const floor = floorError(line, rule);
    if (floor) throw httpError(400, `Line ${i + 1} (${line.name}): ${floor}`);
    return line;
  });
};

// S4: every PO is for a customer (required — "stock" POs without one are no
// longer made; old ones still open).
const customerSnapshot = async (req, customerId) => {
  if (!customerId) throw httpError(400, "Customer is required", { field: "customer" });
  if (!mongoose.isValidObjectId(customerId)) throw httpError(400, "Unknown customer", { field: "customer" });
  const c = await Client.findOne({ _id: customerId, tenant_id: tenantOf(req) }).lean();
  if (!c) throw httpError(400, "Unknown customer", { field: "customer" });
  const address = [c.address, c.city, c.state, c.zip].filter(Boolean).join(", ");
  return {
    customer: c._id,
    snapshot: {
      name: c.company,
      address,
      gstin: c.gst_number || c.vat || "",
      state: c.state || "",
      phone: c.phonenumber || "",
      whatsapp: c.phonenumber || "",
      email: c.email || "",
    },
  };
};

// The customer's PO number (text, up to 60 characters — stored as typed, the
// UI shows it as plain text) and date, on the Purchase PO (R6). Only keys
// that are sent are returned; "" / null clears them.
const cleanCustomerPo = (body) => {
  const out = {};
  if (body.customer_po_number !== undefined) {
    const v = body.customer_po_number;
    if (v !== null && typeof v !== "string" && typeof v !== "number") throw httpError(400, "Customer PO No.: enter text", { field: "customer_po_number" });
    // S4: 1-60 characters — letters, digits, space - _ . ( ) /
    const text = check(V.customerPoNo(v), "customer_po_number");
    out.customer_po_number = text || undefined;
  }
  if (body.customer_po_date !== undefined) {
    const v = body.customer_po_date;
    if (v === null || v === "") out.customer_po_date = undefined;
    else {
      const d = typeof v === "string" ? new Date(v) : null;
      if (!d || isNaN(d.getTime())) throw httpError(400, "Customer PO date is not a valid date", { field: "customer_po_date" });
      out.customer_po_date = d;
    }
  }
  return out;
};

// S4: the same customer PO number on another (not cancelled) PO for the same
// customer is refused — 400 with code "customer_po_duplicate" and the other
// PO(s) so the editor can link to them. (Round 28 only warned.)
const assertCustomerPoFree = async ({ tenantId, customerId, number, excludeId }) => {
  if (!number || !customerId) return;
  const others = await PurchaseOrder.find({
    tenant_id: tenantId,
    type: "purchase",
    customer: customerId,
    customer_po_number: new RegExp(`^${escapeRegExp(number)}$`, "i"),
    status: { $ne: "cancelled" },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("po_number")
    .lean();
  if (others.length) {
    throw httpError(400, `Customer PO No. ${number} is already on ${others.map((o) => o.po_number).join(", ")} for this customer`, {
      field: "customer_po_number",
      code: "customer_po_duplicate",
      existing: others.map((o) => ({ _id: String(o._id), po_number: o.po_number })),
    });
  }
};

// S4 dates: expected delivery ≥ PO date; customer PO date ≤ PO date.
const assertDates = (dates) => {
  const [first] = V.poDates(dates);
  if (first) throw httpError(400, first.message, { field: first.field });
};

// Warnings that don't block the save: a customer GSTIN in the Customers
// module that isn't a valid GSTIN (it is fixed there, not on the PO).
const customerWarnings = (snapshot) => {
  if (snapshot?.gstin && V.gstin(snapshot.gstin).error) return [`The customer's GSTIN "${snapshot.gstin}" doesn't look valid — check it in Customers`];
  return [];
};

const withWarnings = (po, warnings) => (warnings.length ? { ...po.toJSON(), warnings } : po);

// Prices and totals from the price master, plus what the approver should
// look at. Clears any earlier decision: the PO changed. R4: every Purchase PO
// needs an approver's Yes, so "required" is always true; the reasons (price
// raised, margin under the minimum, cost from DP) are information.
const applyEvaluation = (po, lines, rule) => {
  const result = evaluatePo({ lines, type: po.type, taxMode: po.tax_mode, rule });
  po.items = result.lines;
  po.totals = result.totals;
  po.rule_snapshot = { ...rule };
  po.approval = { required: po.type === "purchase" ? true : result.approvalRequired, reasons: result.reasons };
  return result;
};

const ACTION_TEXT = {
  created: "created",
  edited: "edited",
  submitted: "sent for approval",
  approved: "approved",
  auto_approved: "approved",
  rejected: "rejected",
  whatsapp: "sent on WhatsApp",
  customer_po_file: "customer PO attached",
  purchase_po_created: "Brady PO created",
  proforma_created: "proforma invoice created",
};

const record = (req, po, action, note) => {
  po.history.push({ action, by: req.user._id, at: new Date(), note: note || undefined });
};

// Global Activity Log entry, written after the PO is saved. Best effort.
const logActivity = (req, po, action, note) => {
  const verb = ACTION_TEXT[action] || action.replace("status:", "marked ").replace(/_/g, " ");
  ActivityLog.create({
    description: `${po.type === "sales" ? "Sales" : "Purchase"} PO ${po.po_number} ${verb}${note ? ` — ${note}` : ""}`,
    staffid: req.user._id,
    rel_id: po._id,
    rel_type: "purchase_order",
    tenant_id: po.tenant_id,
  }).catch((err) => console.error("[purchase orders] activity log failed:", err.message));
};

// Active staff who hold Purchase Orders > Approve (admins always do) — same
// precedence as hasCapability: the staff's own permission, else their role's.
const findApproverIds = async (tenantId) => {
  const Staff = require("../models/Staff");
  const staff = await Staff.find({ tenant_id: tenantId, active: { $ne: false } })
    .select("admin permissions role")
    .populate("role", "permissions")
    .lean();
  const capOf = (perms) => {
    if (!perms) return undefined;
    const mod = perms instanceof Map ? perms.get(MODULE) : perms[MODULE];
    return mod?.Approve;
  };
  return staff
    .filter((s) => s.admin || !!(capOf(s.permissions) ?? capOf(s.role?.permissions) ?? false))
    .map((s) => String(s._id));
};

// Live bell/toast over the app socket (each staff joins a room named after
// their id). Never fails the request.
const notifyStaff = (req, staffIds, payload) => {
  try {
    const io = req.app?.get("io");
    if (!io) return;
    [...new Set(staffIds.map(String))].forEach((id) => io.to(id).emit("purchaseOrderApproval", payload));
  } catch (err) {
    console.error("[purchase orders] notify failed:", err.message);
  }
};

// R4: EVERY PO waits for an approver's Yes — also when every line is at the
// list price, and also when the person submitting is an approver (Q7: they
// may approve their own PO, but only by pressing Yes on it afterwards).
const submit = async (req, po) => {
  po.status = "pending_approval";
  po.approval.requested_by = req.user._id;
  po.approval.requested_at = new Date();
  record(req, po, "submitted");
  return "pending";
};

const afterSubmit = async (req, po) => {
  logActivity(req, po, "submitted");
  const approverIds = (await findApproverIds(po.tenant_id)).filter((id) => id !== String(req.user._id));
  notifyStaff(req, approverIds, {
    event: "requested",
    poId: String(po._id),
    number: po.po_number,
    by: staffName(req.user),
    // S5: the toast says "is waiting for your approval" + these points.
    reasons: (po.approval?.reasons || []).slice(0, 5),
  });
};

const populatePo = (query) =>
  query
    .populate("created_by", "firstname lastname email")
    .populate("approval.requested_by", "firstname lastname email")
    .populate("approval.decided_by", "firstname lastname email")
    .populate("history.by", "firstname lastname")
    .populate("whatsapp_log.by", "firstname lastname")
    .populate("linked_purchase_po", "po_number status type")
    .populate("source_sales_po", "po_number status type");

// ─── PO endpoints ──────────────────────────────────────────────────────────

// Query values must be plain text: ?status[$ne]=x arrives as an object and
// would otherwise reach Mongo as an operator.
const queryText = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// S2: each row says whether the PO has a (not cancelled) proforma invoice —
// the Delete icon is disabled with "Has a proforma invoice" then.
const withProformaFlag = async (docs) => {
  if (!docs.length) return [];
  const ProformaInvoice = require("../models/ProformaInvoice");
  const ids = await ProformaInvoice.distinct("po", { tenant_id: docs[0].tenant_id, po: { $in: docs.map((d) => d._id) } });
  const has = new Set(ids.map(String));
  return docs.map((d) => ({ ...(d.toJSON ? d.toJSON() : d), has_proforma: has.has(String(d._id)) }));
};

// type / division / status filters shared by the list and the summary cards.
const applyQueryFilters = (filter, query) => {
  for (const key of ["type", "division", "status"]) {
    const raw = query[key];
    if (raw === undefined || raw === "") continue;
    const value = queryText(raw);
    if (!value) throw httpError(400, `Invalid ${key} filter`);
    if (key === "type" && !["purchase", "sales"].includes(value)) throw httpError(400, "Invalid type filter");
    if (key === "status" && !PurchaseOrder.PO_STATUSES.includes(value)) throw httpError(400, "Invalid status filter");
    filter[key] = value;
  }
};

const queryDate = (v, label) => {
  const text = queryText(v);
  const d = text ? new Date(text) : null;
  if (!d || isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date`);
  return d;
};

const listPurchaseOrders = async (req, res) => {
  try {
    const filter = await scopeFilter(req);
    const { from, to } = req.query;
    applyQueryFilters(filter, req.query);
    if (from || to) {
      filter.po_date = {};
      if (from) filter.po_date.$gte = queryDate(from, "From date");
      if (to) filter.po_date.$lte = new Date(queryDate(to, "To date").setHours(23, 59, 59, 999));
    }
    const search = queryText(req.query.search);
    if (search) {
      const re = new RegExp(escapeRegExp(search), "i");
      filter.$or = [{ po_number: re }, { customer_po_number: re }, { "customer_snapshot.name": re }, { "items.name": re }, { "items.item_code": re }];
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const [total, data] = await Promise.all([
      PurchaseOrder.countDocuments(filter),
      PurchaseOrder.find(filter)
        .select("-history -whatsapp_log -rule_snapshot")
        .populate("created_by", "firstname lastname")
        .sort({ po_date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    res.json({ data: await withProformaFlag(data), total, page, pages: Math.max(Math.ceil(total / limit), 1), limit });
  } catch (error) {
    fail(res, error);
  }
};

// Count and value per status, for the summary cards.
const getStats = async (req, res) => {
  try {
    const filter = await scopeFilter(req);
    applyQueryFilters(filter, { type: req.query.type, division: req.query.division });
    filter.tenant_id = new mongoose.Types.ObjectId(String(filter.tenant_id));
    if (filter.created_by) filter.created_by = new mongoose.Types.ObjectId(String(filter.created_by));
    const rows = await PurchaseOrder.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 }, value: { $sum: "$totals.grand_total" } } },
    ]);
    const byStatus = Object.fromEntries(rows.map((r) => [r._id, { count: r.count, value: round2(r.value) }]));
    res.json({ byStatus });
  } catch (error) {
    fail(res, error);
  }
};

// Proformas made from a PO (R5 — the link from the PO side).
const proformasOf = (po) =>
  require("../models/ProformaInvoice")
    .find({ tenant_id: po.tenant_id, po: po._id })
    .select("number status date totals.grand_total")
    .sort({ createdAt: 1 })
    .lean();

const getPurchaseOrder = async (req, res) => {
  try {
    const po = await populatePo(PurchaseOrder.findOne({ _id: (await loadPo(req, req.params.id))._id }));
    const settings = await getSettingsDoc(po.tenant_id);
    res.json({ ...plain(po), format: formatForVersion(settings, po.format_version), proformas: await proformasOf(po) });
  } catch (error) {
    fail(res, error);
  }
};

// R4: what the browser needs to build the PO PDF (F1 layout) — only once an
// approver said Yes (approved / sent / received). Before that: 400.
const getPrintData = async (req, res) => {
  try {
    const po = await loadPo(req, req.params.id);
    if (po.type === "purchase" && !SENDABLE.includes(po.status)) {
      throw httpError(400, "The PO PDF is available only after an approver says Yes");
    }
    const settings = await getSettingsDoc(po.tenant_id);
    const company = po.buyer && po.buyer.name ? po.buyer : await effectiveCompany(settings);
    res.json({ po: plain(po), company });
  } catch (error) {
    fail(res, error);
  }
};

// A date sent in the body: missing/"" = not set; anything unreadable is a 400.
const bodyDate = (v, label) => {
  if (v === undefined || v === null || v === "") return undefined;
  const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date`);
  return d;
};

const createPurchaseOrder = async (req, res) => {
  try {
    if (!(await can(req, "Create"))) throw httpError(403, "You don't have permission to create purchase orders");
    const tenantId = tenantOf(req);
    const settings = await getSettingsDoc(tenantId);
    const { type = "purchase", division, customer, po_date, expected_date, notes, tax_mode, items, submit: doSubmit } = req.body;

    // R1: the module makes only Purchase POs to Brady.
    if (type === "sales") throw httpError(400, "Sales PO was removed — only Purchase POs can be made");
    if (type !== "purchase") throw httpError(400, "Only a Purchase PO can be made");
    const customerPo = cleanCustomerPo(req.body);
    const div = settings.divisions.find((d) => d.key === division && d.active !== false);
    if (!div) throw httpError(400, "Choose a division");
    const poDate = bodyDate(po_date, "PO date");
    const expected = bodyDate(expected_date, "Expected date");

    const conf = plain(settings);
    const { customer: customerId, snapshot } = await customerSnapshot(req, customer);
    assertDates({ po_date: poDate, expected_date: expected, customer_po_date: customerPo.customer_po_date });
    const level = priceLevelOf(settings, customerId);
    const rule = purchaseRule(settings, level);
    const warnings = [];
    const lines = await buildLines(req, items, rule, [], warnings);
    await assertCustomerPoFree({ tenantId, customerId, number: customerPo.customer_po_number });
    const company = await effectiveCompany(settings);

    const po = new PurchaseOrder({
      tenant_id: tenantId,
      type: "purchase",
      division,
      ...(await nextNumber(settings, division, poDate)),
      po_date: poDate,
      expected_date: expected,
      supplier: conf.supplier,
      buyer: company,
      customer: customerId,
      customer_snapshot: snapshot,
      price_level: level,
      tax_mode: tax_mode === "inter" ? "inter" : "intra",
      notes,
      format_version: settings.format_version,
      created_by: req.user._id,
      ...customerPo,
    });
    applyEvaluation(po, lines, rule);
    record(req, po, "created");
    if (doSubmit) await submit(req, po);
    await po.save();

    logActivity(req, po, "created");
    if (doSubmit) await afterSubmit(req, po);
    res.status(201).json(withWarnings(po, [...warnings, ...customerWarnings(snapshot)]));
  } catch (error) {
    fail(res, error);
  }
};

const updatePurchaseOrder = async (req, res) => {
  try {
    if (!(await can(req, "Edit"))) throw httpError(403, "You don't have permission to edit purchase orders");
    const po = await loadPo(req, req.params.id);
    assertNotSales(po);
    // S2: same reason as the disabled Edit icon ("Pending POs are locked", …).
    const blocked = ACT.editBlock(po, { canEdit: true });
    if (blocked) throw httpError(400, blocked);
    const settings = await getSettingsDoc(po.tenant_id);
    const { customer, po_date, expected_date, notes, tax_mode, items, submit: doSubmit } = req.body;

    const customerPo = cleanCustomerPo(req.body);
    const poDate = bodyDate(po_date, "PO date");
    const expected = bodyDate(expected_date, "Expected date");
    const { customer: customerId, snapshot } = await customerSnapshot(req, customer);
    assertDates({
      po_date: poDate || po.po_date,
      expected_date: expected,
      customer_po_date: "customer_po_date" in customerPo ? customerPo.customer_po_date : po.customer_po_date,
    });
    const nextCustomerPoNo = "customer_po_number" in customerPo ? customerPo.customer_po_number : po.customer_po_number;
    // S4: a PO with the customer's PO file attached needs its number.
    if (po.customer_po_file?.url && !nextCustomerPoNo) {
      throw httpError(400, "Customer PO No. is required when the customer's PO file is attached", { field: "customer_po_number" });
    }
    const level = priceLevelOf(settings, customerId);
    const rule = purchaseRule(settings, level);
    const warnings = [];
    const lines = await buildLines(req, items, rule, plain(po).items, warnings);
    await assertCustomerPoFree({ tenantId: po.tenant_id, customerId, number: nextCustomerPoNo, excludeId: po._id });
    po.customer = customerId;
    po.customer_snapshot = snapshot;
    po.price_level = level;
    po.buyer = await effectiveCompany(settings);
    Object.entries(customerPo).forEach(([k, v]) => po.set(k, v));
    if (poDate) po.po_date = poDate;
    po.expected_date = expected;
    po.notes = notes;
    po.tax_mode = tax_mode === "inter" ? "inter" : "intra";
    applyEvaluation(po, lines, rule);
    record(req, po, "edited");
    if (doSubmit) await submit(req, po);
    await po.save();

    logActivity(req, po, "edited");
    if (doSubmit) await afterSubmit(req, po);
    res.json(withWarnings(po, [...warnings, ...customerWarnings(snapshot)]));
  } catch (error) {
    fail(res, error);
  }
};

// Re-checks against today's price master, then sends it for approval (R4:
// always — there is no "approved at once").
const submitPurchaseOrder = async (req, res) => {
  try {
    const po = await loadPo(req, req.params.id);
    const ownDraft = String(po.created_by) === String(req.user._id) && (await can(req, "Create"));
    if (!ownDraft && !(await can(req, "Edit"))) throw httpError(403, "You don't have permission to submit this PO");
    assertNotSales(po);
    if (po.status !== "draft") throw httpError(400, "Only a draft PO can be submitted");
    if (!po.customer) throw httpError(400, "Customer is required — edit the PO and choose the customer", { field: "customer" });
    const settings = await getSettingsDoc(po.tenant_id);
    const level = priceLevelOf(settings, po.customer);
    const rule = purchaseRule(settings, level);
    const existing = plain(po).items;
    po.price_level = level;
    po.buyer = await effectiveCompany(settings);
    applyEvaluation(po, await buildLines(req, existing, rule, existing), rule);
    await submit(req, po);
    await po.save();
    await afterSubmit(req, po);
    res.json(po);
  } catch (error) {
    fail(res, error);
  }
};

const decide = (decision) => async (req, res) => {
  try {
    if (!(await can(req, "Approve"))) throw httpError(403, "You don't have permission to approve purchase orders");
    const po = await loadPo(req, req.params.id);
    assertNotSales(po);
    if (po.status !== "pending_approval") throw httpError(400, "This PO is not waiting for approval");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (decision === "rejected" && !reason) throw httpError(400, "Please give a reason for saying No");

    po.status = decision === "approved" ? "approved" : "draft";
    po.approval.decision = decision;
    po.approval.decided_by = req.user._id;
    po.approval.decided_at = new Date();
    po.approval.reason = reason || undefined;
    record(req, po, decision, reason);
    await po.save();

    logActivity(req, po, decision, reason);
    const makerId = po.approval.requested_by || po.created_by;
    if (makerId && String(makerId) !== String(req.user._id)) {
      notifyStaff(req, [makerId], {
        event: decision,
        poId: String(po._id),
        number: po.po_number,
        by: staffName(req.user),
        reason: reason || undefined,
      });
    }
    res.json(po);
  } catch (error) {
    fail(res, error);
  }
};

const approvePurchaseOrder = decide("approved");
const rejectPurchaseOrder = decide("rejected");

const getPendingApprovals = async (req, res) => {
  try {
    if (!(await can(req, "Approve"))) throw httpError(403, "You don't have permission to approve purchase orders");
    const data = await PurchaseOrder.find({ tenant_id: tenantOf(req), status: "pending_approval" })
      .select("-history -whatsapp_log")
      .populate("approval.requested_by", "firstname lastname email")
      .populate("created_by", "firstname lastname")
      .sort({ "approval.requested_at": 1 });
    res.json(await withProformaFlag(data));
  } catch (error) {
    fail(res, error);
  }
};

// "Partially received" carries how much of each line has arrived so far:
// received = [{ line_id, qty_received }], each from 0 up to the ordered qty.
// Lines not listed keep what was recorded before.
const applyReceivedQty = (po, received) => {
  if (!Array.isArray(received) || received.length === 0) {
    throw httpError(400, "Enter the received quantity for at least one item");
  }
  for (const entry of received) {
    const line = entry && po.items.id(String(entry.line_id || ""));
    if (!line) throw httpError(400, "Unknown item line");
    const qty = lineAmount(entry.qty_received, `${line.name}: received quantity`, line.qty);
    if (qty === undefined) throw httpError(400, `${line.name}: enter the received quantity`);
    line.qty_received = qty;
  }
  const total = po.items.reduce((s, l) => s + (l.qty_received || 0), 0);
  if (total === 0) throw httpError(400, "Nothing received yet — enter a received quantity");
  if (po.items.every((l) => (l.qty_received || 0) >= l.qty)) {
    throw httpError(400, "Everything has arrived — mark the PO as Received instead");
  }
};

const receivedNote = (po, next) =>
  next === "partially_received"
    ? po.items.map((l) => `${l.name}: ${l.qty_received || 0}/${l.qty}`).join(", ")
    : "";

const changeStatus = async (req, res) => {
  try {
    if (!(await can(req, "Edit"))) throw httpError(403, "You don't have permission to edit purchase orders");
    const po = await loadPo(req, req.params.id);
    assertNotSales(po);
    const next = req.body?.status;
    if (!(STATUS_MOVES[po.status] || []).includes(next)) {
      throw httpError(400, `A ${po.status.replace(/_/g, " ")} PO can't be marked ${String(next).replace(/_/g, " ")}`);
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (next === "partially_received") applyReceivedQty(po, req.body?.received);
    if (next === "received") po.items.forEach((line) => { line.qty_received = line.qty; });
    po.status = next;
    record(req, po, `status:${next}`, note || receivedNote(po, next));
    await po.save();
    logActivity(req, po, `status:${next}`, note || receivedNote(po, next));
    res.json(po);
  } catch (error) {
    fail(res, error);
  }
};

// Drafts and cancelled POs only — anything that went out stays on record.
const deletePurchaseOrder = async (req, res) => {
  try {
    if (!(await can(req, "Delete"))) throw httpError(403, "You don't have permission to delete purchase orders");
    const po = await loadPo(req, req.params.id);
    // S2: the same reasons as the disabled Delete icon.
    const blocked = ACT.deleteBlock(po, { canDelete: true, hasProforma: (await proformasOf(po)).length > 0 });
    if (blocked === ACT.HAS_PROFORMA) throw httpError(400, "Has a proforma invoice — this PO stays on record");
    if (blocked) throw httpError(400, `${blocked}. Only draft or cancelled POs can be deleted`);
    await po.deleteOne();
    logActivity(req, po, "deleted");
    res.json({ message: "Purchase order deleted" });
  } catch (error) {
    fail(res, error);
  }
};

// ─── WhatsApp ──────────────────────────────────────────────────────────────

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN") : "");

// Placeholders shared with the PDF format (see poPdf.ts on the frontend).
const fillPlaceholders = (text, po) => {
  const party = po.type === "purchase" ? po.supplier : po.customer_snapshot;
  const values = {
    po_number: po.po_number,
    po_date: fmtDate(po.po_date),
    expected_date: fmtDate(po.expected_date),
    party_name: party?.name || "",
    "customer.name": po.customer_snapshot?.name || "",
    "supplier.name": po.supplier?.name || "",
    customer_po_number: po.customer_po_number || "",
    grand_total: (po.totals?.grand_total || 0).toFixed(2),
  };
  return String(text || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
};

const defaultRecipient = (po) =>
  po.type === "purchase" ? po.supplier?.whatsapp || po.supplier?.phone : po.customer_snapshot?.whatsapp || po.customer_snapshot?.phone;

// Hosts a browser-made PDF and sends it through the company's connected
// WhatsApp number: as a document inside the 24-hour window, otherwise with
// the document template from PO Settings. Shared by POs and proformas.
// Returns what happened; the caller records it.
const activeIntegration = async (tenantId) => {
  const { getActiveIntegration } = require("../services/whatsapp_service");
  const integration = await getActiveIntegration(tenantId);
  if (!integration) throw httpError(400, "Connect a WhatsApp number first (WhatsApp Marketing > Settings)");
  return integration;
};

const deliverPdf = async ({ req, integration, tenantId, to, buffer, filename, caption, params, folder = "purchase_orders" }) => {
  const { sendDocumentMessage, sendDocumentTemplate } = require("../services/whatsapp_service");

  const upload = require("../hrms/utils/cloudinary_config");
  let url = await upload.uploadToCloudinary({ buffer, originalname: filename }, folder);
  if (url.startsWith("/")) {
    // No Cloudinary: a local /uploads path, which Meta can only fetch
    // through the server's public address.
    const base = String(process.env.BACKEND_PUBLIC_URL || "").replace(/\/+$/, "");
    if (!base && integration.is_live) throw httpError(500, "File hosting is not set up on this server (BACKEND_PUBLIC_URL)");
    url = `${base}${url}`;
  }

  const WhatsAppInbox = require("../models/WhatsAppInbox");
  const last10 = to.slice(-10);
  const lastInbound = await WhatsAppInbox.findOne({ tenant_id: tenantId, mobile: last10, direction: "in" })
    .sort({ received_at: -1 })
    .select("received_at")
    .lean();
  const withinWindow = !!lastInbound && Date.now() - new Date(lastInbound.received_at).getTime() < 24 * 60 * 60 * 1000;

  const settings = await getSettingsDoc(tenantId);
  const wa = plain(settings).whatsapp || {};
  let method = "document";
  let result;
  if (withinWindow) {
    result = await sendDocumentMessage(integration, to, url, filename, caption);
  } else if (wa.template_name) {
    method = "template";
    result = await sendDocumentTemplate(integration, to, wa.template_name, wa.template_language, url, filename, (wa.body_params || []).map(params));
  } else {
    method = "template";
    result = {
      success: false,
      error: "This number hasn't messaged you in the last 24 hours. Set a WhatsApp document template in PO Settings to send outside that window.",
    };
  }
  const at = new Date();
  const log = {
    to,
    at,
    by: req.user._id,
    method,
    status: result.success ? (result.skipped ? "simulated" : "sent") : "failed",
    message_id: result.messageId || undefined,
    error: result.success ? undefined : result.error,
  };
  if (result.success && !result.skipped) {
    WhatsAppInbox.create({
      tenant_id: tenantId,
      from: integration.display_phone_number || "",
      mobile: last10,
      message: filename,
      msg_type: "document",
      wa_message_id: result.messageId,
      media_url: url,
      direction: "out",
      delivery_status: "sent",
      received_at: new Date(),
    }).catch((err) => console.error("[purchase orders] inbox copy failed:", err.message));
  }
  return { result, log, at };
};

// The uploaded file must really be a PDF (size is capped by the route's multer).
const assertPdf = (file, missing) => {
  if (!file) throw httpError(400, missing);
  if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw httpError(400, "Only a PDF file can be sent");
};

// R4: the browser builds the PO PDF (F1 layout) and posts it here; it goes
// to the supplier's (Brady's) WhatsApp number — only after an approver's Yes.
const sendOnWhatsApp = async (req, res) => {
  try {
    if (!(await can(req, "Edit"))) throw httpError(403, "You don't have permission to send purchase orders");
    const po = await loadPo(req, req.params.id);
    assertNotSales(po);
    if (!SENDABLE.includes(po.status)) throw httpError(400, "Only an approved PO can be sent");
    assertPdf(req.file, "The PO PDF is missing");
    const integration = await activeIntegration(po.tenant_id);

    const digits = String(req.body?.to || defaultRecipient(po) || "").replace(/\D/g, "");
    if (digits.length < 10) throw httpError(400, "Add the supplier's WhatsApp number in PO Settings");

    const filename = `${po.po_number.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
    const { result, log, at } = await deliverPdf({
      req,
      integration,
      tenantId: po.tenant_id,
      to: digits,
      buffer: req.file.buffer,
      filename,
      caption: po.po_number,
      params: (p) => fillPlaceholders(p, po),
    });

    // The message has already gone out, so record it with atomic updates instead
    // of po.save(): a status change made meanwhile must not lose this record.
    const sentNote = { action: "whatsapp", by: req.user._id, at, note: `to ${digits}${result.skipped ? " (test mode)" : ""}` };
    await PurchaseOrder.updateOne(
      { _id: po._id },
      { $push: { whatsapp_log: log, ...(result.success ? { history: sentNote } : {}) } }
    );
    if (result.success) {
      await PurchaseOrder.updateOne(
        { _id: po._id, status: "approved" },
        { $set: { status: "sent" }, $push: { history: { action: "status:sent", by: req.user._id, at } } }
      );
    }
    const saved = await PurchaseOrder.findById(po._id);

    if (!result.success) return res.status(400).json({ message: result.error, po: saved });
    logActivity(req, saved, "whatsapp", `to ${digits}`);
    res.json(saved);
  } catch (error) {
    fail(res, error);
  }
};

// ─── Customer PO attachment ────────────────────────────────────────────────

// What a file really is, from its first bytes (never the name or the
// browser's type): only a PDF, JPG or PNG may be attached.
const fileKind = (buffer) => {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { mime: "image/png", ext: "png" };
  return null;
};

// The customer's own PO kept on the Purchase PO for reference (R6; any status
// except cancelled — it is not part of the pricing). A new upload replaces
// the old one. Size and file count are capped by the route's multer.
const uploadCustomerPoFile = async (req, res) => {
  try {
    const po = await loadPo(req, req.params.id);
    const ownPo = String(po.created_by) === String(req.user._id) && (await can(req, "Create"));
    if (!ownPo && !(await can(req, "Edit"))) throw httpError(403, "You don't have permission to change this PO");
    assertNotSales(po);
    if (po.status === "cancelled") throw httpError(400, "This PO is cancelled");
    if (!req.file) throw httpError(400, "Attach the customer's PO (PDF, JPG or PNG)");
    // S4: the customer's PO file needs its number on the PO first.
    if (!po.customer_po_number) {
      throw httpError(400, "Customer PO No. is required when the customer's PO file is attached — save it on the PO first", { field: "customer_po_number" });
    }
    const kind = fileKind(req.file.buffer);
    if (!kind) throw httpError(400, "Only a PDF, JPG or PNG file can be attached");

    // Stored under a name we make (never the uploaded one); the original name
    // is kept only as text to show.
    const upload = require("../hrms/utils/cloudinary_config");
    const url = await upload.uploadToCloudinary(
      { buffer: req.file.buffer, originalname: `customer-po-${po._id}.${kind.ext}`, mimetype: kind.mime },
      "purchase_orders"
    );
    const name = String(req.file.originalname || `customer-po.${kind.ext}`).slice(0, 200);
    const at = new Date();
    // Atomic update (like the WhatsApp send) so a status change made meanwhile isn't lost.
    await PurchaseOrder.updateOne(
      { _id: po._id },
      {
        $set: { customer_po_file: { url, name, size: req.file.size, mime: kind.mime, uploaded_at: at, uploaded_by: req.user._id } },
        $push: { history: { action: "customer_po_file", by: req.user._id, at, note: name } },
      }
    );
    logActivity(req, po, "customer_po_file", name);
    res.json(await populatePo(PurchaseOrder.findById(po._id)));
  } catch (error) {
    fail(res, error);
  }
};

// ─── Settings endpoints ────────────────────────────────────────────────────

// Settings as the API shows them: no counters / format history; Maps as
// plain objects; the company block as the PDFs will print it (prefilled
// from the CRM company profile until an admin saves it).
const settingsOut = async (settings) => {
  const { counters, format_history, import_mappings, ...rest } = settings.toObject({ flattenMaps: true });
  return {
    ...rest,
    company: await effectiveCompany(settings),
    import_mappings: (import_mappings || []).map((m) => ({ signature: m.signature, sheet_name: m.sheet_name, saved_at: m.saved_at })),
    format_versions: format_history.map((h) => ({ version: h.version, saved_at: h.saved_at })),
  };
};

const getPoSettings = async (req, res) => {
  try {
    res.json(await settingsOut(await getSettingsDoc(tenantOf(req))));
  } catch (error) {
    fail(res, error);
  }
};

// Q2: a customer's price level — which price is the floor for the selling
// price on their POs. Admins and staff with Manage Prices.
const setCustomerPriceLevel = async (req, res) => {
  try {
    if (!(req.user.admin || req.user.is_superadmin || (await can(req, "Manage Prices")))) {
      throw httpError(403, "You don't have permission to change price levels");
    }
    const { customer, level } = req.body || {};
    if (!["end_user", "distributor"].includes(level)) throw httpError(400, "Price level must be End user or Distributor");
    if (!mongoose.isValidObjectId(customer)) throw httpError(400, "Unknown customer");
    const c = await Client.findOne({ _id: customer, tenant_id: tenantOf(req) }).select("company").lean();
    if (!c) throw httpError(400, "Unknown customer");
    const settings = await getSettingsDoc(tenantOf(req));
    const before = priceLevelOf(settings, c._id);
    if (level === "end_user") settings.customer_price_levels.delete(String(c._id));
    else settings.customer_price_levels.set(String(c._id), level);
    await settings.save();
    if (before !== level) {
      ActivityLog.create({
        description: `PO price level of ${c.company}: ${before.replace("_", " ")} → ${level.replace("_", " ")}`,
        staffid: req.user._id,
        rel_id: c._id,
        rel_type: "customer",
        tenant_id: settings.tenant_id,
      }).catch((err) => console.error("[purchase orders] activity log failed:", err.message));
    }
    res.json({ customer: String(c._id), level });
  } catch (error) {
    fail(res, error);
  }
};

const percentOrNull = (v, label) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (isNaN(n) || n < 0 || n > 100) throw httpError(400, `${label} must be between 0 and 100`);
  return n;
};

// An on / off value: true / false (or "true" / "false" from a form); missing
// keeps `fallback`. Anything else is an error.
const onOff = (v, fallback, label) => {
  if (v === undefined || v === null) return fallback;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw httpError(400, `${label} must be on or off`);
};

// `current` is the saved rule: a missing price_floor keeps its saved value.
const cleanRule = (rule, label, current = {}) => {
  if (!rule) return undefined;
  if (!PRICE_FIELDS.includes(rule.list_price_field)) throw httpError(400, `${label}: choose which price is the list price`);
  return {
    list_price_field: rule.list_price_field,
    max_discount_pct: percentOrNull(rule.max_discount_pct, `${label} maximum discount`),
    min_margin_pct: check(V.marginPct(rule.min_margin_pct, { label: `${label} minimum margin %` }), "rules.min_margin_pct"),
    allow_below_list: rule.allow_below_list !== false,
    price_floor: onOff(rule.price_floor, !!current.price_floor, `${label}: "Price can only go up"`),
  };
};

// Admins only. A new format gets a new version; POs already made keep theirs.
const updatePoSettings = async (req, res) => {
  try {
    if (!(req.user.admin || req.user.is_superadmin)) throw httpError(403, "Only an admin can change PO settings");
    const settings = await getSettingsDoc(tenantOf(req));
    const { divisions, rules, supplier, whatsapp, format, company, proforma, default_series } = req.body;

    if (divisions !== undefined) {
      if (!Array.isArray(divisions) || divisions.length === 0) throw httpError(400, "Keep at least one division");
      const seen = new Set();
      // Every number series needs its own prefix, or two divisions/types would
      // produce the same PO number (unique per company).
      const prefixes = new Set();
      const cleaned = divisions.map((d) => {
        if (!d || typeof d !== "object") throw httpError(400, "Every division needs a name");
        if (/[\/\s]/.test(String(d.purchase_prefix || "").trim())) throw httpError(400, `Division "${d.name}": the PO prefix can't contain "/" or spaces`, { field: "purchase_prefix" });
        // S4: 1-10 letters, digits or - (required — checked below when empty).
        if (String(d.purchase_prefix || "").trim()) check(V.poPrefix(d.purchase_prefix, { label: `Division "${d.name}": PO number prefix` }), "purchase_prefix");
        for (const p of [d.purchase_prefix, d.sales_prefix]) {
          const k = String(p || "").trim().toLowerCase();
          if (k && prefixes.has(k)) throw httpError(400, `Number prefix "${String(p).trim()}" is used twice — each division and PO type needs its own`);
          prefixes.add(k);
        }
        const key = String(d.key || d.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!key || !String(d.name || "").trim()) throw httpError(400, "Every division needs a name");
        if (seen.has(key)) throw httpError(400, `Division "${d.name}" is listed twice`);
        // R1: only the PO prefix is needed now (the old Sales PO prefix is kept if set).
        if (!String(d.purchase_prefix || "").trim()) throw httpError(400, `Division "${d.name}" needs a PO number prefix`, { field: "purchase_prefix" });
        seen.add(key);
        return {
          key,
          name: String(d.name).trim(),
          purchase_prefix: String(d.purchase_prefix).trim(),
          sales_prefix: String(d.sales_prefix || "").trim(),
          active: d.active !== false,
        };
      });
      // A prefix already printed on POs of another division / type (e.g. after
      // a rename) can't be given out again: its numbers would collide.
      for (const d of cleaned) {
        for (const type of ["purchase", "sales"]) {
          const prefix = type === "purchase" ? d.purchase_prefix : d.sales_prefix;
          if (!prefix) continue;
          // Old numbers "<prefix>-2026-0001" and new ones "<prefix>/01/26-27".
          const clash = await PurchaseOrder.exists({
            tenant_id: settings.tenant_id,
            po_number: new RegExp(`^${escapeRegExp(prefix)}(-[0-9]{4}-|/[0-9]{2,}/[0-9]{2}-[0-9]{2}$)`, "i"),
            $or: [{ division: { $ne: d.key } }, { type: { $ne: type } }],
          });
          if (clash) throw httpError(400, `Number prefix "${prefix}" was already used on other POs — choose a new one`);
        }
      }
      const removed = settings.divisions.map((d) => d.key).filter((k) => !seen.has(k));
      if (removed.length) {
        const used = await PurchaseOrder.exists({ tenant_id: settings.tenant_id, division: { $in: removed } });
        if (used) throw httpError(400, "A division that already has POs can't be removed — switch it off instead");
      }
      settings.divisions = cleaned;
    }
    if (rules) {
      const saved = plain(settings).rules || {};
      if (rules.purchase) settings.rules.purchase = cleanRule(rules.purchase, "Purchase PO", saved.purchase);
      if (rules.sales) settings.rules.sales = cleanRule(rules.sales, "Sales PO", saved.sales);
    }
    if (supplier) {
      ["name", "address", "gstin", "state", "phone", "whatsapp", "email"].forEach((k) => {
        if (supplier[k] !== undefined) settings.supplier[k] = String(supplier[k] ?? "").trim();
      });
      if (!settings.supplier.name) throw httpError(400, "The supplier needs a name", { field: "supplier.name" });
      check(V.personOrCompanyName(settings.supplier.name, { label: "Supplier name" }), "supplier.name");
      check(V.stateName(settings.supplier.state, { label: "Supplier state" }), "supplier.state");
      // S4 formats (empty = not set).
      settings.supplier.gstin = check(V.gstin(settings.supplier.gstin, { label: "Supplier GSTIN" }), "supplier.gstin");
      check(V.phone(settings.supplier.phone, { label: "Supplier phone" }), "supplier.phone");
      check(V.phone(settings.supplier.whatsapp, { label: "Supplier WhatsApp number" }), "supplier.whatsapp");
      check(V.email(settings.supplier.email, { label: "Supplier email" }), "supplier.email");
    }
    if (company !== undefined) {
      if (!company || typeof company !== "object" || Array.isArray(company)) throw httpError(400, "Company details: send the fields");
      const next = {};
      for (const k of COMPANY_FIELDS) {
        const v = company[k];
        if (v !== undefined && v !== null && typeof v !== "string") throw httpError(400, `Company details: ${k.replace(/_/g, " ")} must be text`);
        const text = String(v ?? "").trim();
        if (text.length > (["po_terms", "address"].includes(k) ? 3000 : 300)) throw httpError(400, `Company details: ${k.replace(/_/g, " ")} is too long`);
        next[k] = text;
      }
      if (!next.name) throw httpError(400, "Company details: the company name is required", { field: "company.name" });
      next.gstin = check(V.gstin(next.gstin, { label: "Company GSTIN" }), "company.gstin");
      check(V.phone(next.phone, { label: "Company phone" }), "company.phone");
      check(V.email(next.email, { label: "Company email" }), "company.email");
      check(V.personOrCompanyName(next.name, { label: "Company name" }), "company.name");
      check(V.stateName(next.state, { label: "Company state" }), "company.state");
      check(V.logoUrl(next.logo_url), "company.logo_url");
      check(V.personOrCompanyName(next.bank_account_name, { label: "Account name" }), "company.bank_account_name");
      check(V.bankAccountNo(next.bank_account_no), "company.bank_account_no");
      next.bank_ifsc = check(V.ifsc(next.bank_ifsc), "company.bank_ifsc");
      settings.company = { ...next, saved_at: new Date() };
    }
    if (proforma !== undefined) {
      if (!proforma || typeof proforma !== "object") throw httpError(400, "Proforma settings: send the fields");
      const prefix = check(V.proformaPrefix(proforma.prefix), "proforma.prefix");
      // S4 / S5: whole days 1 to 365.
      const days = proforma.valid_days === undefined ? settings.proforma?.valid_days ?? 15 : check(V.validDays(proforma.valid_days), "proforma.valid_days");
      settings.proforma = { prefix, valid_days: days };
    }
    // S1: the series PO Items opens on ("" = All series).
    if (default_series !== undefined) {
      if (default_series === null || default_series === "") settings.default_series = "";
      else settings.default_series = check(V.seriesName(default_series), "default_series");
    }
    if (whatsapp) {
      settings.whatsapp = {
        template_name: check(V.waTemplateName(whatsapp.template_name), "whatsapp.template_name"),
        template_language: check(V.waLanguage(whatsapp.template_language), "whatsapp.template_language"),
        body_params: Array.isArray(whatsapp.body_params) ? whatsapp.body_params.map((p) => String(p)) : [],
      };
    }
    if (format && typeof format === "object") {
      if (JSON.stringify(format) !== JSON.stringify(settings.format)) {
        settings.format_version += 1;
        settings.format = format;
        settings.format_history.push({ version: settings.format_version, format, saved_at: new Date(), saved_by: req.user._id });
        settings.markModified("format");
      }
    }
    await settings.save();
    res.json(await settingsOut(settings));
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

// ─── PO items (the module's own item list + price master) ──────────────────
// Separate from the CRM Items module: nothing here reads or writes Item.js.

// A price cell: a number, or text like "1,250" / "₹ 1,250.50". Anything else
// ("12abc", "1e5", "abc", negatives) is an error, never a guessed number.
const priceNum = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? round2(v) : NaN;
  const text = String(v).trim();
  if (text === "") return undefined;
  const cleaned = text.replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? round2(Number(cleaned)) : NaN;
};

// GST %: 0-100, "18" and "18%" are fine; anything else is an error.
const gstNum = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 && v <= 100 ? round2(v) : NaN;
  const text = String(v).trim().replace(/\s*%$/, "");
  if (text === "") return undefined;
  return /^\d+(\.\d+)?$/.test(text) && Number(text) <= 100 ? round2(Number(text)) : NaN;
};

// Text fields of a PO item with their length limits (same as PoItem.js).
const PO_ITEM_TEXT = {
  item_code: ["Item code", 100],
  y_code: ["Y code", 50],
  name: ["Name", 300],
  description: ["Description", 2000],
  hsn: ["HSN", 50],
  unit: ["Unit", 30],
  lead_time: ["Lead time", 100],
  remarks: ["Remarks", 500],
  category: ["Category", 100],
};
// Columns of the simple Excel upload / export.
const PO_ITEM_COLUMNS = ["item_code", "y_code", "name", "description", "hsn", "unit", "tax_rate", ...ALL_PRICE_FIELDS, "lead_time", "remarks", "category"];

const textField = (v, label, max) => {
  if (v === undefined) return undefined;
  if (v === null) return "";
  if (typeof v !== "string" && typeof v !== "number") throw httpError(400, `${label}: enter text`);
  const s = String(v).trim();
  if (s.length > max) throw httpError(400, `${label} can't be longer than ${max} characters`);
  return s;
};

// One PO item's fields from the form or a sheet row. A missing or blank value
// is "not sent" (an edit keeps the old value); a bad value is a 400.
const cleanPoItem = (src, { isNew }) => {
  const out = {};
  for (const [f, [label, max]] of Object.entries(PO_ITEM_TEXT)) {
    const v = textField(src[f], label, max);
    if (v !== undefined) out[f] = v;
  }
  if (out.y_code) out.y_code = check(V.yCode(out.y_code), "y_code");
  // Round 29: the name is optional on a new item (it becomes the catalog no.).
  if (out.name === "" && !isNew) throw httpError(400, "Name can't be empty", { field: "name" });
  if (out.unit === "") out.unit = "Nos";
  const tax = gstNum(src.tax_rate);
  if (Number.isNaN(tax)) throw httpError(400, "GST % must be a number from 0 to 100");
  if (tax !== undefined) out.tax_rate = tax;
  for (const f of ALL_PRICE_FIELDS) {
    const v = priceNum(src[f]);
    if (Number.isNaN(v)) throw httpError(400, `${f.replace(/_/g, " ")} is not a valid amount`);
    if (v !== undefined) out[f] = v;
  }
  if (src.active !== undefined) {
    if (typeof src.active !== "boolean") throw httpError(400, "Active must be true or false");
    out.active = src.active;
  }
  return out;
};

const exactText = (s) => new RegExp(`^${escapeRegExp(s)}$`, "i");

// Another item of the company with the same name or item code (case-insensitive).
const poItemClash = async (tenantId, { name, item_code }, excludeId) => {
  const or = [name && { name: exactText(name) }, item_code && { item_code: exactText(item_code) }].filter(Boolean);
  if (!or.length) return null;
  const other = await PoItem.findOne({ tenant_id: tenantId, $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    .select("name item_code")
    .lean();
  if (!other) return null;
  // S4: 409 "already exists — edit it instead" (catalog no. per company, case-insensitive).
  return item_code && other.item_code && other.item_code.toLowerCase() === item_code.toLowerCase()
    ? `Catalog no. "${other.item_code}" already exists — edit it instead`
    : `A PO item named "${other.name}" already exists — edit it instead`;
};

// The series (price-list sheets) in use, for "reuse the existing name".
const existingSeries = async (tenantId) => (await PoItem.distinct("category", { tenant_id: tenantId })).filter(Boolean);

// S4 rules for the "Add PO item" / edit form (the Excel upload keeps the
// price list's own catalog texts): catalog no. (2-40, letters digits - / . _),
// series and End User Price are required; HSN 4/6/8 digits; prices up to
// 1,00,00,000. A new series name matching an existing one (any case) reuses
// it. Returns warnings (an unusual GST %).
const strictPoItem = async (tenantId, values, { isNew }) => {
  const warnings = [];
  if (isNew || "item_code" in values) values.item_code = check(V.catalogNo(values.item_code), "item_code");
  if (isNew || "category" in values) {
    const name = check(V.seriesName(values.category), "category");
    values.category = V.reuseSeries(name, await existingSeries(tenantId));
  }
  if (isNew || "end_customer_price" in values) {
    if (!(Number(values.end_customer_price) > 0)) throw httpError(400, "End User Price is required", { field: "end_customer_price" });
  }
  for (const f of ALL_PRICE_FIELDS) {
    if (values[f] !== undefined && values[f] > V.MAX_PRICE) throw httpError(400, `${f.replace(/_/g, " ")} can't be more than 1,00,00,000`, { field: f });
  }
  if (values.hsn) values.hsn = check(V.hsn(values.hsn, { label: "HSN" }), "hsn");
  if (values.unit) values.unit = check(V.unitName(values.unit), "unit");
  if (isNew && !values.name) values.name = values.item_code;
  const gst = V.gstWarning(values.tax_rate);
  if (gst) warnings.push(gst);
  return warnings;
};

// Serialises PO item writes per company, so a double-click or two uploads at
// once can't slip the same name / code past the duplicate check (same idea as
// item_controller withNameLock; no unique index).
const itemLocks = new Map();
const withItemLock = async (tenantId, fn) => {
  const key = String(tenantId);
  const prev = itemLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  itemLocks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (itemLocks.get(key) === chain) itemLocks.delete(key);
  }
};

const canManagePrices = async (req) => {
  if (!(await can(req, "Manage Prices"))) throw httpError(403, "You don't have permission to change PO items or prices");
};

const loadPoItem = async (req, id) => {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, "PO item not found");
  const item = await PoItem.findOne({ _id: id, tenant_id: tenantOf(req) });
  if (!item) throw httpError(404, "PO item not found");
  return item;
};

const describeChanges = (changes) =>
  Object.entries(changes).map(([f, c]) => `${f.replace(/_/g, " ")} ${c.from ?? "-"} → ${c.to}`).join(", ");

const logItemChanges = (req, entries) => {
  if (!entries.length) return;
  ActivityLog.insertMany(
    entries.map(({ item, changes, created }) => ({
      description: created
        ? `PO items: added "${item.name}" (${describeChanges(changes)})`
        : `PO items: "${item.name}" ${describeChanges(changes)}`,
      staffid: req.user._id,
      rel_id: item._id,
      rel_type: "po_item",
      tenant_id: item.tenant_id,
    }))
  ).catch((err) => console.error("[purchase orders] PO item log failed:", err.message));
};

// What a new item's values look like in the change log / preview.
const addedChanges = (values) =>
  Object.fromEntries(Object.entries(values).filter(([f]) => f !== "name").map(([f, v]) => [f, { from: null, to: v }]));

// Old value of a field, with the schema defaults for anything never set.
const itemValue = (item, f) => item[f] ?? (ALL_PRICE_FIELDS.includes(f) || f === "tax_rate" ? 0 : "");

// Any PO viewer can read the list (the editor's picker uses it with
// ?active=true). Filters: search (catalog, Y code, name, description, HSN, or
// an obsolete catalog the item replaces), category (price-list sheet),
// active=true|false|all.
// The PO Items filter (search / series / active) — shared by the list and the
// export, so "Export" gives exactly the rows the table shows.
const poItemFilter = (req) => {
  const filter = { tenant_id: tenantOf(req) };
  const search = queryText(req.query.search);
  if (search) {
    const re = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: re }, { item_code: re }, { y_code: re }, { description: re }, { hsn: re }, { replaces: re }];
  }
  const category = req.query.category;
  if (category !== undefined && category !== "" && category !== "all") {
    const text = queryText(category);
    if (!text) throw httpError(400, "Invalid category filter");
    // S1: "__none__" = items with no series (made before series existed).
    if (text === "__none__") filter.category = { $in: ["", null] };
    else filter.category = new RegExp(`^${escapeRegExp(text)}$`, "i");
  }
  const active = req.query.active;
  if (active === "true") filter.active = { $ne: false };
  else if (active === "false") filter.active = false;
  else if (active !== undefined && active !== "" && active !== "all") throw httpError(400, "Invalid active filter");
  return filter;
};

const listPoItems = async (req, res) => {
  try {
    const filter = poItemFilter(req);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const [total, data] = await Promise.all([
      PoItem.countDocuments(filter),
      PoItem.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit),
    ]);
    res.json({ data, total, page, pages: Math.max(Math.ceil(total / limit), 1), limit });
  } catch (error) {
    fail(res, error);
  }
};

const createPoItem = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const values = cleanPoItem(req.body || {}, { isNew: true });
    const warnings = await strictPoItem(tenantId, values, { isNew: true });
    const item = await withItemLock(tenantId, async () => {
      const clash = await poItemClash(tenantId, values);
      if (clash) throw httpError(409, clash, { field: "item_code", code: "po_item_exists" });
      return PoItem.create({ ...values, tenant_id: tenantId, created_by: req.user._id });
    });
    logItemChanges(req, [{ item, changes: addedChanges(values), created: true }]);
    res.status(201).json(warnings.length ? { ...item.toJSON(), warnings } : item);
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

// Any field may change, including switching the item off (active: false).
// POs already made keep their own copy of the old values.
const updatePoItem = async (req, res) => {
  try {
    await canManagePrices(req);
    const item = await loadPoItem(req, req.params.itemId);
    const values = cleanPoItem(req.body || {}, { isNew: false });
    await strictPoItem(item.tenant_id, values, { isNew: false });
    const changes = {};
    const saved = await withItemLock(item.tenant_id, async () => {
      const clash = await poItemClash(item.tenant_id, { name: values.name, item_code: values.item_code }, item._id);
      if (clash) throw httpError(409, clash, { field: "item_code", code: "po_item_exists" });
      for (const [f, v] of Object.entries(values)) {
        const from = itemValue(item, f);
        if (from !== v) changes[f] = { from: from === "" ? null : from, to: v };
      }
      Object.entries(changes).forEach(([f, c]) => item.set(f, f === "item_code" && c.to === "" ? undefined : c.to));
      return item.save();
    });
    logItemChanges(req, Object.keys(changes).length ? [{ item: saved, changes }] : []);
    res.json(saved);
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

// Only an item no PO uses; otherwise switch it off.
const deletePoItem = async (req, res) => {
  try {
    await canManagePrices(req);
    const item = await loadPoItem(req, req.params.itemId);
    const used = await PurchaseOrder.exists({ tenant_id: item.tenant_id, "items.item_id": item._id });
    if (used) throw httpError(400, "This item is used on a PO — switch it off instead");
    await item.deleteOne();
    ActivityLog.create({
      description: `PO items: deleted "${item.name}"`,
      staffid: req.user._id,
      rel_id: item._id,
      rel_type: "po_item",
      tenant_id: item.tenant_id,
    }).catch((err) => console.error("[purchase orders] PO item log failed:", err.message));
    res.json({ message: "PO item deleted" });
  } catch (error) {
    fail(res, error);
  }
};

// Matches upload rows to PO items by item code, else by name
// (case-insensitive). Blank cells leave that value as it is; unknown items
// become new PO items. The same item twice in one sheet is an error row.
const matchItemRows = async (req, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, "The sheet has no rows");
  const items = await PoItem.find({ tenant_id: tenantOf(req) }).lean();
  const byCode = new Map(items.filter((i) => i.item_code).map((i) => [i.item_code.toLowerCase(), i]));
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
  const seenItems = new Set();
  const seenKeys = new Set();

  return rows.map((row, i) => {
    const out = { row: i + 2, item_code: "", name: "" }; // +2: sheet row (after the header)
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ...out, status: "error", error: "Empty row" };
    out.item_code = String(row.item_code ?? "").trim();
    out.name = String(row.name ?? "").trim();
    let values;
    try {
      // A blank cell (empty, spaces, null) means "leave as it is".
      const blank = (v) => v === null || (typeof v === "string" && v.trim() === "");
      values = cleanPoItem(Object.fromEntries(PO_ITEM_COLUMNS.map((f) => [f, blank(row[f]) ? undefined : row[f]])), { isNew: false });
    } catch (err) {
      return { ...out, status: "error", error: err.message };
    }
    const code = values.item_code || "";
    const name = values.name || "";
    if (!code && !name) return { ...out, status: "error", error: "Needs an item code or name" };

    const keys = [code && `c:${code.toLowerCase()}`, name && `n:${name.toLowerCase()}`].filter(Boolean);
    const item = (code && byCode.get(code.toLowerCase())) || (name && byName.get(name.toLowerCase()));
    if (keys.some((k) => seenKeys.has(k)) || (item && seenItems.has(String(item._id)))) {
      return { ...out, status: "error", error: "Same item appears earlier in the sheet" };
    }
    if (item && name) {
      const other = byName.get(name.toLowerCase());
      if (other && String(other._id) !== String(item._id)) {
        return { ...out, status: "error", error: `Another PO item is already named "${other.name}"` };
      }
    }
    keys.forEach((k) => seenKeys.add(k));

    if (!item) {
      if (!name) return { ...out, status: "error", error: "New item needs a name" };
      return { ...out, status: "new", changes: addedChanges(values), values };
    }
    seenItems.add(String(item._id));
    const changes = {};
    for (const [f, v] of Object.entries(values)) {
      const from = itemValue(item, f);
      // Matching ignores case, so a name / code differing only in case is no change.
      const same = f === "name" || f === "item_code" ? String(from).toLowerCase() === String(v).toLowerCase() : from === v;
      if (!same) changes[f] = { from: from === "" ? null : from, to: v };
    }
    return { ...out, name: item.name, item_id: item._id, status: Object.keys(changes).length ? "update" : "unchanged", changes };
  });
};

const rowSummary = (rows) => {
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { new: count("new"), update: count("update"), unchanged: count("unchanged"), error: count("error") };
};

const previewPoItems = async (req, res) => {
  try {
    await canManagePrices(req);
    const rows = await matchItemRows(req, req.body?.rows);
    res.json({ rows, summary: rowSummary(rows) });
  } catch (error) {
    fail(res, error);
  }
};

// Applies the same matching as the preview (re-run inside the lock, so it
// sees what is saved now). Rows with errors are skipped.
const importPoItems = async (req, res) => {
  try {
    await canManagePrices(req);
    const tenantId = tenantOf(req);
    const { rows, logs, updated, created } = await withItemLock(tenantId, async () => {
      const matched = await matchItemRows(req, req.body?.rows);
      const entries = [];
      const updates = matched.filter((r) => r.status === "update");
      if (updates.length) {
        await PoItem.bulkWrite(
          updates.map((r) => ({
            updateOne: {
              filter: { _id: r.item_id, tenant_id: tenantId },
              update: { $set: Object.fromEntries(Object.entries(r.changes).map(([f, c]) => [f, c.to])) },
            },
          }))
        );
        updates.forEach((r) => entries.push({ item: { _id: r.item_id, name: r.name, tenant_id: tenantId }, changes: r.changes }));
      }
      const news = matched.filter((r) => r.status === "new");
      const docs = news.length
        ? await PoItem.insertMany(news.map((r) => ({ ...r.values, tenant_id: tenantId, created_by: req.user._id })))
        : [];
      docs.forEach((d, i) => entries.push({ item: d, changes: news[i].changes, created: true }));
      return { rows: matched, logs: entries, updated: updates.length, created: docs.length };
    });

    logItemChanges(req, logs);
    const skipped = rows.filter((r) => r.status === "error").length;
    res.json({
      message: `PO items saved: ${updated} updated, ${created} added${skipped ? ", rows with errors skipped" : ""}.`,
      updated,
      created,
      skipped,
    });
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

// Price-list sheets the items came from, for the PO Items category filter.
const listPoItemCategories = async (req, res) => {
  try {
    const cats = await PoItem.distinct("category", { tenant_id: tenantOf(req) });
    res.json(cats.filter(Boolean).sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    fail(res, error);
  }
};

// S1: every series (price-list sheet) with its item count, for the panel on
// the right of PO Items and the picker's series filter. default_series is the
// saved one; "resolved" falls back to "" (All series) when it has no items.
// ?active=true counts only switched-on items (the PO editor's picker).
const listPoItemSeries = async (req, res) => {
  try {
    const tenantId = new mongoose.Types.ObjectId(String(tenantOf(req)));
    const match = { tenant_id: tenantId };
    if (req.query.active === "true") match.active = { $ne: false };
    const rows = await PoItem.aggregate([{ $match: match }, { $group: { _id: "$category", count: { $sum: 1 } } }]);
    const series = rows.filter((r) => r._id).map((r) => ({ name: r._id, count: r.count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const none = rows.filter((r) => !r._id).reduce((s, r) => s + r.count, 0);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const settings = await getSettingsDoc(tenantOf(req));
    const saved = settings.default_series ?? "M210";
    const ref = settings.price_list_ref || {};
    // S6: the reference price list (for "+ Add Catalog No.")
    const reference = { count: ref.upload_id ? ref.count || 0 : 0, file_name: ref.upload_id ? ref.file_name || "" : "", uploaded_at: ref.upload_id ? ref.uploaded_at || null : null };
    res.json({ series, none, total, default_series: saved, resolved: resolveDefaultSeries(saved, series), reference });
  } catch (error) {
    fail(res, error);
  }
};

// The series PO Items opens on: the saved default when it has items (any
// case), else "" = All series.
const resolveDefaultSeries = (saved, series) => {
  if (!saved) return "";
  const hit = series.find((s) => s.name.toLowerCase() === String(saved).toLowerCase() && s.count > 0);
  return hit ? hit.name : "";
};

// Every PO item with the upload columns (+ active), for the Excel export.
const exportPoItems = async (req, res) => {
  try {
    const items = await PoItem.find(poItemFilter(req)).sort({ name: 1 }).lean();
    res.json({
      rows: items.map((i) => ({
        ...Object.fromEntries(PO_ITEM_COLUMNS.map((f) => [f, itemValue(i, f)])),
        active: i.active !== false,
      })),
    });
  } catch (error) {
    fail(res, error);
  }
};

module.exports = {
  listPurchaseOrders,
  getStats,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  getPendingApprovals,
  changeStatus,
  deletePurchaseOrder,
  sendOnWhatsApp,
  uploadCustomerPoFile,
  getPrintData,
  getPoSettings,
  updatePoSettings,
  setCustomerPriceLevel,
  listPoItems,
  listPoItemCategories,
  listPoItemSeries,
  resolveDefaultSeries,
  createPoItem,
  updatePoItem,
  deletePoItem,
  previewPoItems,
  importPoItems,
  exportPoItems,
  fillPlaceholders,
  // pure helpers, exported for unit tests
  cleanRule,
  cleanCustomerPo,
  fileKind,
  priceNum,
  gstNum,
  cleanPoItem,
  // shared with the price-list import and proforma controllers
  _internal: {
    MODULE,
    SENDABLE,
    can,
    httpError,
    fail,
    check,
    existingSeries,
    plain,
    tenantOf,
    loadPo,
    getSettingsDoc,
    effectiveCompany,
    withItemLock,
    canManagePrices,
    logItemChanges,
    deliverPdf,
    activeIntegration,
    assertPdf,
    escapeRegExp,
    queryText,
    staffName,
    lineAmount,
    bodyDate,
    fillPlaceholders,
    textField,
    priceNum,
    gstNum,
    fileKind,
  },
};
