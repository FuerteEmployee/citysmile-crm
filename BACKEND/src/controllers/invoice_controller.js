const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const InvoiceService = require("../services/InvoiceService");
const CustomFieldService = require("../services/CustomFieldService");
const Client = require("../models/Client");
const Payment = require("../models/Payment");
const { logActivity } = require("../services/ActivityLogService");
const { isEkagraUser } = require("../middleware/auth");
const CreditNote = require("../models/CreditNote");
const invoiceSettings = require("../services/invoiceSettings");

// Which invoices this user may see: their own company's, and with
// "View (Own)" or the "assigned" access (Setup > Settings > Invoices > Allow
// staff members to view invoices where they are assigned to) only the ones
// they are the sale agent of.
const invoiceScope = (req) => {
  const scope = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) scope.tenant_id = req.user.tenant_id;
  if (req.permissionLevel === "own" || req.permissionLevel === "assigned") scope.created_by = req.user._id;
  return scope;
};

const duplicateNumberError = (res, number) =>
  res.status(400).json({ message: `Invoice number "${number}" is already used by another invoice.` });

// Ekagra Engineering is registered in Bihar (state code 10) — overrides the
// default Gujarat home-state used for intra/inter-state GST classification.
const EKAGRA_HOME_STATE = { name: "bihar", code: "10" };
const homeStateFor = (user) => (isEkagraUser(user) ? EKAGRA_HOME_STATE : undefined);

// Fields a caller may set on an invoice. Everything else in the body
// (_id, tenant_id, createdAt, subtotal/total/total_tax …) is ignored — totals
// are always recalculated by the server.
const INVOICE_FIELDS = [
  "client", "number", "auto_number", "date", "duedate", "status", "currency",
  "discount_percent", "discount_type", "discount_fixed", "adjustment",
  "voucherType", "document_type", "partyAddress", "partyGroup", "termsOfPayment",
  "gstin", "vat", "items", "notes", "terms", "adminnote", "project", "tags",
  "created_by", "salesPerson", "branch", "bank_detail",
];
const ITEM_FIELDS = [
  "description", "long_description", "qty", "rate", "tax", "tax_name", "itemGroup",
  "itemHSN", "itemBatch", "unit", "gstPercentage", "freight_charge", "amount",
];
const pickFields = (obj, fields) =>
  Object.fromEntries(fields.filter((k) => obj[k] !== undefined && obj[k] !== "").map((k) => [k, obj[k]]));

const TEXT_LIMITS = {
  number: 100, voucherType: 255, partyGroup: 255, termsOfPayment: 255, gstin: 20, vat: 50,
  salesPerson: 255, branch: 255, partyAddress: 2000, notes: 10000, adminnote: 10000, terms: 10000,
};
const STATUSES = Invoice.schema.path("status").enumValues;
const isNum = (v) => v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v));
const badDate = (v) => v !== undefined && v !== null && isNaN(new Date(v).getTime());
const outOfRange = (v) => {
  if (v === undefined || v === null || badDate(v)) return false;
  const y = new Date(v).getFullYear();
  return y < 1970 || y > 2100;
};
const { isValidGstinFormat } = require("../services/gstService");
const { isTrinetraPilotUser, canAccessBankDetails } = require("../middleware/auth");

// Status follows the recorded payments: "paid" needs the full amount paid,
// "partially_paid" some of it, "unpaid"/"draft" none. Returns an error or null.
const PAYMENT_STATUSES = ["paid", "recorded", "partially_paid"];
const checkStatusAgainstPayments = (status, totalPaid, total) => {
  if (status === undefined) return null;
  const fullyPaid = totalPaid >= (Number(total) || 0) - 0.005 && totalPaid > 0;
  if ((status === "paid" || status === "recorded") && !fullyPaid) return "Record a payment for the full amount to mark this invoice as paid.";
  if (status === "partially_paid" && (totalPaid <= 0 || fullyPaid)) return "Record a part payment to mark this invoice as partially paid.";
  if ((status === "unpaid" || status === "draft") && totalPaid > 0) return "This invoice has payments. Remove them first to mark it as unpaid.";
  return null;
};

// Branch / Sales Person are pilot-only fields and Bank Details exist only for
// the pilot and Ekagra — other companies' requests can't set them.
const stripUnavailableFields = (payload, user) => {
  if (!isTrinetraPilotUser(user)) { delete payload.branch; delete payload.salesPerson; }
  if (!canAccessBankDetails(user)) delete payload.bank_detail;
};

// Fills what the form leaves to the server: line amount and the company's default currency.
const fillDefaults = async (payload, tenantId) => {
  if (Array.isArray(payload.items)) {
    payload.items.forEach((it) => {
      if (it && typeof it === "object" && (it.amount === undefined || it.amount === null)) {
        const qty = it.qty === undefined || it.qty === null ? 1 : Number(it.qty) || 0;
        it.amount = Math.round(qty * (Number(it.rate) || 0) * 100) / 100;
      }
    });
  }
  if (!payload.currency) {
    const Currency = require("../models/Currency");
    const def = await Currency.findOne({ tenant_id: tenantId ?? null, isdefault: true }).select("name").lean();
    if (def) payload.currency = def.name;
  }
};

// Invoices still unpaid after their due date become "overdue". Run when the
// list or one invoice is read, so no scheduled job is needed.
const markOverdue = (filter) =>
  Invoice.updateMany(
    { ...filter, status: { $in: ["unpaid", "sent", "sent_later"] }, duedate: { $lt: new Date(new Date().toDateString()) } },
    { $set: { status: "overdue" } }
  );

// Checks an invoice payload (for an update: the saved invoice merged with the
// change). Returns an error message, or null when it is fine. Linked records
// (customer, project, sale agent, bank detail, currency) must belong to the
// caller's company.
const validateInvoice = async (data, tenantId, isCreate) => {
  const sameTenant = (extra = {}) => ({ ...extra, tenant_id: tenantId ?? null });

  if (!data.client) return "Please select a customer.";
  if (!mongoose.isValidObjectId(data.client)) return "Invalid customer.";
  if (isCreate || data._clientChanged) {
    if (!(await Client.exists(sameTenant({ _id: data.client })))) return "Customer not found.";
  }

  if (data.number !== undefined && !String(data.number).trim()) return "Invoice number is required.";
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (data[field] !== undefined && data[field] !== null && String(data[field]).length > max) {
      return `${field} is too long (max ${max} characters).`;
    }
  }
  if (data.status !== undefined && !STATUSES.includes(data.status)) return `Invalid status "${data.status}".`;

  if (badDate(data.date) || outOfRange(data.date)) return "Invalid invoice date.";
  if (badDate(data.duedate) || outOfRange(data.duedate)) return "Invalid due date.";
  if ((isCreate || data._gstinChanged) && data.gstin && !isValidGstinFormat(data.gstin)) {
    return "Invalid GSTIN — it must be 15 characters like 24ABCDE1234F1Z5.";
  }
  if ((isCreate || data._branchChanged) && data.branch) {
    const HRMSBranch = require("../hrms/models/hrms_branch_model");
    if (!(await HRMSBranch.exists(sameTenant({ name: data.branch })))) return `Branch "${data.branch}" not found.`;
  }
  if ((isCreate || data._datesChanged) && data.date && data.duedate && new Date(data.duedate) < new Date(data.date)) {
    return "Due date cannot be before the invoice date.";
  }

  // Older invoices may have no items; a status-only update must still work.
  if (isCreate || data._itemsChanged) {
    if (!Array.isArray(data.items) || data.items.length === 0) return "Enter at least one item.";
    for (const [i, item] of data.items.entries()) {
      if (!item || typeof item !== "object") return `Item ${i + 1} is invalid.`;
      for (const k of ["qty", "rate", "freight_charge", "tax", "gstPercentage"]) {
        const v = item[k];
        if (v === undefined || v === null || v === "") continue;
        if (!isNum(v)) return `Item ${i + 1}: ${k} must be a number.`;
        if (Number(v) < 0) return `Item ${i + 1}: ${k} cannot be negative.`;
      }
      if (Number(item.tax) > 100 || Number(item.gstPercentage) > 100) return `Item ${i + 1}: tax cannot be more than 100%.`;
    }
  }

  if (data.discount_percent !== undefined && data.discount_percent !== null) {
    if (!isNum(data.discount_percent)) return "Discount must be a number.";
    if (Number(data.discount_percent) < 0 || Number(data.discount_percent) > 100) return "Discount must be between 0 and 100%.";
  }
  if (data.discount_type !== undefined && !["", "percent", "fixed", "no_discount"].includes(data.discount_type)) {
    return "Invalid discount type.";
  }
  if (data.discount_fixed !== undefined && data.discount_fixed !== null) {
    if (!isNum(data.discount_fixed) || Number(data.discount_fixed) < 0) return "Discount must be a positive amount.";
  }
  if (data.adjustment !== undefined && data.adjustment !== null && !isNum(data.adjustment)) return "Adjustment must be a number.";

  if (data.project) {
    if (!mongoose.isValidObjectId(data.project)) return "Invalid project.";
    const Project = require("../models/Project");
    const project = await Project.findOne(sameTenant({ _id: data.project })).select("clientid").lean();
    if (!project) return "Project not found.";
    if (project.clientid && String(project.clientid) !== String(data.client)) return "This project belongs to another customer.";
  }
  if (data.created_by && (isCreate || data._agentChanged)) {
    if (!mongoose.isValidObjectId(data.created_by)) return "Invalid sale agent.";
    const Staff = require("../models/Staff");
    if (!(await Staff.exists(sameTenant({ _id: data.created_by })))) return "Sale agent not found.";
  }
  if (data.bank_detail && (isCreate || data._bankChanged)) {
    if (!mongoose.isValidObjectId(data.bank_detail)) return "Invalid bank detail.";
    const BankDetail = require("../models/BankDetail");
    if (!(await BankDetail.exists(sameTenant({ _id: data.bank_detail, active: { $ne: false } })))) return "Bank detail not found.";
  }
  if (data.currency && (isCreate || data._currencyChanged)) {
    const Currency = require("../models/Currency");
    // Only checked when the company has set up currencies at all.
    if ((await Currency.countDocuments(sameTenant())) > 0 && !(await Currency.exists(sameTenant({ name: data.currency })))) {
      return `Unknown currency "${data.currency}".`;
    }
  }
  return null;
};

// Bad ids / types that slip past validateInvoice are the caller's fault, not a server error.
const sendError = (res, error) => {
  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern || {})[0] || "field";
    return res.status(409).json({ message: `A record with this ${field} already exists.` });
  }
  if (error?.name === "CastError" || error?.name === "ValidationError") {
    return res.status(400).json({ message: error.message });
  }
  return res.status(500).json({ message: error.message });
};
const invalidId = (res) => res.status(400).json({ message: "Invalid invoice id" });
// The GSTIN typed on the invoice (pre-filled from the customer) decides
// CGST+SGST vs IGST; the customer record is the fallback.
const withInvoiceGstin = (client, gstin) =>
  client && gstin ? { ...(client.toObject ? client.toObject() : client), gst_number: gstin } : client;
const discountTooBig = (data, totals) => data.discount_type === "fixed" && Number(data.discount_fixed) > totals.subtotal;
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One batched query for the whole page instead of one CustomFieldValue query
// per invoice (was N+1 — the dominant cost on the Invoices list once the
// tenant has hundreds of rows, e.g. right after a bulk import).
const enrichInvoices = async (invoices) => {
  try {
    const valuesByInvoice = await CustomFieldService.getValuesForMany(
      invoices.map((inv) => inv._id),
      "invoice"
    );
    return invoices.map((inv) => {
      const invObj = inv.toObject();
      invObj.custom_fields = valuesByInvoice.get(String(inv._id)) || {};
      return invObj;
    });
  } catch (err) {
    console.error("Error batch-fetching invoice custom fields:", err);
    return invoices.map((inv) => inv.toObject());
  }
};

// Raw enum values collapse into the 5 canonical buckets the UI's status
// cards use — mirrors the normalization the frontend used to do client-side
// over the full invoice list (sent/sent_later -> unpaid, recorded -> paid).
const STATUS_BUCKETS = {
  unpaid: ["unpaid", "sent", "sent_later"],
  paid: ["paid", "recorded"],
  partially_paid: ["partially_paid"],
  overdue: ["overdue"],
  cancelled: ["cancelled"],
};

const getInvoices = async (req, res) => {
  try {
    const baseFilter = {};
    if (req.query.client) baseFilter.client = req.query.client;
    Object.assign(baseFilter, invoiceScope(req));
    await markOverdue(baseFilter);

    const { page, limit, search, status, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard/report aggregation, exports, the customer-tab invoice list)
    // keep getting the full bare array exactly as before.
    if (!isPaginated) {
      const invoices = await Invoice.find(baseFilter)
        .populate("client", "company")
        .populate("project", "name")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 });
      return res.json(await enrichInvoices(invoices));
    }

    const filter = { ...baseFilter };
    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchTerm = String(search).trim();
      const re = new RegExp(escapeRegExp(searchTerm), "i");
      const matchingClients = await Client.find({ company: re }).select("_id");
      // Status is shown in the table via the STATUS_BUCKETS label (e.g. "Paid"),
      // not the raw stored enum value — resolve which bucket(s)' label text
      // matches so a search like "paid" also finds "recorded" invoices.
      const STATUS_LABELS = {
        unpaid: "Unpaid",
        paid: "Paid",
        partially_paid: "Partially Paid",
        overdue: "Overdue",
        cancelled: "Cancelled",
      };
      const searchLower = searchTerm.toLowerCase();
      const matchingStatusValues = Object.entries(STATUS_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(searchLower))
        .flatMap(([bucket]) => STATUS_BUCKETS[bucket] || []);
      filter.$or = [
        { number: re },
        { salesPerson: re },
        { voucherType: re },
        { partyAddress: re },
        { partyGroup: re },
        { termsOfPayment: re },
        { gstin: re },
        { branch: re },
        { "items.description": re },
        { "items.itemGroup": re },
        { "items.itemHSN": re },
        { "items.itemBatch": re },
        { client: { $in: matchingClients.map((c) => c._id) } },
        { status: { $in: matchingStatusValues } },
      ];
    }
    if (status && status !== "all") filter.status = { $in: STATUS_BUCKETS[status] || [status] };
    if (branch) filter.branch = branch;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    // Status-card counts/totals always reflect the whole tenant (matching
    // prior behavior), independent of the currently active search/status/
    // branch filters — only the `client` scoping (customer-tab usage) applies.
    const [total, statusAgg, invoices] = await Promise.all([
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: baseFilter },
        {
          $addFields: {
            statusBucket: {
              $switch: {
                branches: [
                  { case: { $in: ["$status", ["sent", "sent_later"]] }, then: "unpaid" },
                  { case: { $eq: ["$status", "recorded"] }, then: "paid" },
                ],
                default: { $ifNull: ["$status", "unpaid"] },
              },
            },
          },
        },
        // Per currency too, so a USD invoice isn't added into a ₹ total.
        { $group: { _id: { bucket: "$statusBucket", currency: "$currency" }, count: { $sum: 1 }, total: { $sum: "$total" } } },
      ]),
      Invoice.find(filter)
        .populate("client", "company")
        .populate("project", "name")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichInvoices(invoices),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      statusAgg: Object.values(
        statusAgg.reduce((acc, s) => {
          const row = (acc[s._id.bucket] ||= { status: s._id.bucket, count: 0, total: 0, byCurrency: {} });
          row.count += s.count;
          row.total = Math.round((row.total + s.total) * 100) / 100;
          const cur = s._id.currency || "";
          row.byCurrency[cur] = Math.round(((row.byCurrency[cur] || 0) + s.total) * 100) / 100;
          return acc;
        }, {})
      ),
    });
  } catch (error) {
    sendError(res, error);
  }
};

// Distinct branch values actually stored on invoices — the Branch filter
// dropdown was only ever populated from the separate HRMS branch master, so
// a branch name that arrived via import (free text, no HRMS record) could
// never be selected there even though it displays fine in the table.
const getInvoiceBranches = async (req, res) => {
  try {
    const baseFilter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) baseFilter.tenant_id = req.user.tenant_id;
    const branches = await Invoice.distinct("branch", { ...baseFilter, branch: { $nin: [null, ""] } });
    res.json(branches.sort());
  } catch (error) {
    sendError(res, error);
  }
};

const getInvoiceById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    await markOverdue({ _id: req.params.id, ...invoiceScope(req) });
    const invoice = await Invoice.findOne({ _id: req.params.id, ...invoiceScope(req) })
      .populate("created_by", "firstname lastname")
      .populate("client", "company contact_person email phonenumber address city state zip country billing_street billing_city billing_state billing_zip billing_country gst_number pan_number vat")
      .populate("project", "name")
      .populate({ path: "bank_detail", populate: { path: "branch" } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const custom_fields_values = await CustomFieldService.getValues(invoice._id, "invoice");
    const invObj = invoice.toObject();
    invObj.custom_fields = custom_fields_values;
    // For "Show Total Paid / Credits Applied / Amount Due On Invoice".
    const [paidAgg, creditNotes] = await Promise.all([
      Payment.aggregate([{ $match: { invoice: invoice._id } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      CreditNote.find({ "invoices_credited.invoice": invoice._id }).select("invoices_credited").lean(),
    ]);
    invObj.total_paid = Number(paidAgg[0]?.sum) || 0;
    invObj.credits_applied = creditNotes.reduce(
      (sum, cn) => sum + (cn.invoices_credited || []).filter((x) => String(x.invoice) === String(invoice._id)).reduce((a, x) => a + (Number(x.amount) || 0), 0),
      0
    );
    res.json(invObj);
  } catch (error) {
    sendError(res, error);
  }
};

// GET /api/invoices/next-number — the number a new invoice will get, plus the
// Setup > Settings > Invoices defaults the form prefills.
const getNextInvoiceNumber = async (req, res) => {
  try {
    const tenantId = req.user?.is_superadmin ? null : req.user?.tenant_id;
    const { number, cfg } = await invoiceSettings.previewNextInvoiceNumber(tenantId, req.query.date);
    res.json({ number, dueAfter: cfg.dueAfter, clientNote: cfg.clientNote, terms: cfg.terms });
  } catch (error) {
    sendError(res, error);
  }
};

const createInvoice = async (req, res) => {
  try {
    const payload = pickFields(req.body || {}, INVOICE_FIELDS);
    if (Array.isArray(payload.items)) payload.items = payload.items.map((it) => (it && typeof it === "object" ? pickFields(it, ITEM_FIELDS) : it));
    // The sale agent defaults to whoever creates the invoice, so "View (Own)"
    // staff can see invoices they made.
    if (!payload.created_by) payload.created_by = req.user?._id;

    const tenantId = req.user?.tenant_id;
    const invalid = (await validateInvoice(payload, tenantId, true)) || checkStatusAgainstPayments(payload.status, 0, 1);
    if (invalid) return res.status(400).json({ message: invalid });
    stripUnavailableFields(payload, req.user);
    await fillDefaults(payload, tenantId);

    const client = withInvoiceGstin(await Client.findById(payload.client), payload.gstin);
    const totals = InvoiceService.calculateTotals(payload, client, homeStateFor(req.user));
    if (discountTooBig(payload, totals)) return res.status(400).json({ message: "Discount cannot be more than the subtotal." });
    if (totals.total < 0) return res.status(400).json({ message: "Invoice total cannot be negative." });
    delete totals.totalTax;
    const invoiceData = {
      ...payload,
      ...totals,
    };
    // Setup > Settings > Invoices > "Invoice due after (days)" when no due date was given.
    if (!invoiceData.duedate) {
      const { dueAfter } = await invoiceSettings.getInvoiceSettings(tenantId);
      const base = invoiceData.date ? new Date(invoiceData.date) : new Date();
      invoiceData.duedate = new Date(base.getTime() + dueAfter * 24 * 60 * 60 * 1000);
    }

    // The number shown on the form came from /next-number (auto_number) or
    // is missing: give the company's next number (Prefix, Next Invoice
    // Number, Format, Padding). A number the user typed is kept as-is.
    const autoNumber = payload.auto_number === true || payload.auto_number === "true" || !payload.number;
    delete invoiceData.auto_number;
    let invoice;
    if (autoNumber) {
      invoice = await invoiceSettings.createWithNextNumber(tenantId, invoiceData.date, (number) =>
        Invoice.create({ ...invoiceData, number, tenant_id: tenantId })
      );
    } else {
      try {
        invoice = await Invoice.create({ ...invoiceData, tenant_id: tenantId });
      } catch (err) {
        if (err?.code === 11000) return duplicateNumberError(res, invoiceData.number);
        throw err;
      }
    }
    
    if (invoice) {
      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(invoice._id, "invoice", req.body.custom_fields, invoice.tenant_id);
      }
      logActivity(req, `Created invoice: ${invoice.number || invoice._id}`, { rel_id: invoice._id, rel_type: "invoice" });
      res.status(201).json(invoice);
    } else {
      res.status(400).json({ message: "Invalid invoice data" });
    }
  } catch (error) {
    sendError(res, error);
  }
};

const updateInvoice = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const invoice = await Invoice.findOne({ _id: req.params.id, ...invoiceScope(req) });
    if (invoice) {
      const payload = pickFields(req.body || {}, INVOICE_FIELDS);
      if (Array.isArray(payload.items)) payload.items = payload.items.map((it) => (it && typeof it === "object" ? pickFields(it, ITEM_FIELDS) : it));
      delete payload.auto_number;

      const merged = { ...invoice.toObject(), ...payload };
      const changed = (k) => k in payload && String(payload[k]) !== String(invoice[k] ?? "");
      Object.assign(merged, {
        _clientChanged: changed("client"),
        _agentChanged: changed("created_by"),
        _bankChanged: changed("bank_detail"),
        _currencyChanged: changed("currency"),
        _itemsChanged: "items" in payload,
        _datesChanged: "date" in payload || "duedate" in payload,
        _gstinChanged: changed("gstin"),
        _branchChanged: changed("branch"),
      });
      let invalid = await validateInvoice(merged, invoice.tenant_id, false);
      if (!invalid && changed("status")) {
        const paidAgg = await Payment.aggregate([{ $match: { invoice: invoice._id } }, { $group: { _id: null, sum: { $sum: "$amount" } } }]);
        invalid = checkStatusAgainstPayments(payload.status, Number(paidAgg[0]?.sum) || 0, invoice.total);
      }
      if (invalid) return res.status(400).json({ message: invalid });
      stripUnavailableFields(payload, req.user);
      if (Array.isArray(payload.items)) await fillDefaults({ items: payload.items, currency: payload.currency || invoice.currency }, invoice.tenant_id);

      // Recalculate only when something that feeds the totals changed, and from
      // the saved invoice merged with the change. A partial update such as
      // { status } (single or bulk status change) used to be recalculated from
      // the payload alone — no items — which reset subtotal and total to 0.
      const affectsTotals = ["items", "discount_percent", "discount_type", "discount_fixed", "adjustment", "client"].some((k) => k in payload);
      let totals = {};
      if (affectsTotals) {
        const client = withInvoiceGstin(await Client.findById(merged.client), merged.gstin);
        totals = InvoiceService.calculateTotals(merged, client, homeStateFor(req.user));
        if (discountTooBig(merged, totals)) return res.status(400).json({ message: "Discount cannot be more than the subtotal." });
        if (totals.total < 0) return res.status(400).json({ message: "Invoice total cannot be negative." });
        delete totals.totalTax;
      }
      Object.assign(invoice, { ...payload, ...totals });

      let updatedInvoice;
      try {
        updatedInvoice = await invoice.save();
      } catch (err) {
        if (err?.code === 11000) return duplicateNumberError(res, payload.number);
        throw err;
      }
      // A new total can turn a paid invoice into a part-paid one (or back).
      if (affectsTotals) {
        await InvoiceService.updateStatus(invoice._id);
        updatedInvoice = await Invoice.findById(invoice._id);
      }

      if (req.body.custom_fields) {
        await CustomFieldService.handlePost(invoice._id, "invoice", req.body.custom_fields, invoice.tenant_id);
      }

      logActivity(req, `Updated invoice: ${updatedInvoice.number || updatedInvoice._id}`, { rel_id: updatedInvoice._id, rel_type: "invoice" });

      res.json(updatedInvoice);
    } else {
      res.status(404).json({ message: "Invoice not found" });
    }
  } catch (error) {
    sendError(res, error);
  }
};

const deleteInvoice = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const paymentCount = await Payment.countDocuments({ invoice: req.params.id });
    if (paymentCount > 0) {
      return res.status(400).json({ message: "Cannot delete an invoice with recorded payments. Remove the payments first." });
    }

    const scope = invoiceScope(req);
    const target = await Invoice.findOne({ _id: req.params.id, ...scope }).select("_id number date tenant_id createdAt");
    if (!target) return res.status(404).json({ message: "Invoice not found" });

    const cfg = await invoiceSettings.getInvoiceSettings(target.tenant_id);
    if (cfg.deleteOnlyLast) {
      const last = await Invoice.findOne({ tenant_id: target.tenant_id ?? null }).sort({ createdAt: -1 }).select("_id number");
      if (last && String(last._id) !== String(target._id)) {
        return res.status(400).json({ message: `Only the most recent invoice (${last.number}) can be deleted — Setup > Settings > Invoices > "Delete invoice allowed only on last invoice".` });
      }
    }

    const invoice = await Invoice.findByIdAndDelete(target._id);
    if (invoice) {
      await invoiceSettings.releaseNumberOnDelete(invoice.tenant_id, invoice);
      // Also delete related custom field values if any
      try {
        await CustomFieldService.deleteValues(req.params.id, "invoice");
      } catch (err) {
        console.error(`Error deleting custom fields for invoice ${req.params.id}:`, err);
      }
      logActivity(req, `Deleted invoice: ${invoice.number || invoice._id}`, { rel_type: "invoice" });
      res.json({ message: "Invoice deleted successfully" });
    } else {
      res.status(404).json({ message: "Invoice not found" });
    }
  } catch (error) {
    sendError(res, error);
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// invoice from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large invoice lists. Invoices with recorded
// payments are skipped, same rule as the single-delete endpoint.
const bulkDeleteInvoices = async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
    if (ids.length === 0) return res.status(400).json({ message: "No invoice ids provided" });

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const matched = await Invoice.find(query).select("_id").lean();
    const matchedIds = matched.map((m) => m._id);

    const paidInvoiceIds = new Set(
      (await Payment.find({ invoice: { $in: matchedIds } }).distinct("invoice")).map(String)
    );
    let deletableIds = matchedIds.filter((id) => !paidInvoiceIds.has(String(id)));

    // "Delete invoice allowed only on last invoice": only the newest invoice may go.
    const tenantForRules = req.user?.is_superadmin ? null : req.user?.tenant_id;
    const cfg = await invoiceSettings.getInvoiceSettings(tenantForRules);
    let notLastSkipped = 0;
    if (cfg.deleteOnlyLast) {
      const last = await Invoice.findOne({ tenant_id: tenantForRules ?? null }).sort({ createdAt: -1 }).select("_id");
      const allowed = deletableIds.filter((id) => last && String(id) === String(last._id));
      notLastSkipped = deletableIds.length - allowed.length;
      deletableIds = allowed;
    }
    const deletedDocs = deletableIds.length ? await Invoice.find({ _id: { $in: deletableIds } }).select("number date tenant_id").lean() : [];

    const result = deletableIds.length
      ? await Invoice.deleteMany({ _id: { $in: deletableIds } })
      : { deletedCount: 0 };
    await CustomFieldService.deleteValuesForMany(deletableIds, "invoice");
    for (const doc of deletedDocs) await invoiceSettings.releaseNumberOnDelete(doc.tenant_id, doc);

    logActivity(req, `Bulk-deleted ${result.deletedCount} invoice(s)`, { rel_type: "invoice" });
    res.json({
      message: `Deleted ${result.deletedCount} invoice(s)${paidInvoiceIds.size ? `. ${paidInvoiceIds.size} skipped (has recorded payments).` : ""}${notLastSkipped ? `. ${notLastSkipped} skipped (only the most recent invoice can be deleted).` : ""}`,
      deletedCount: result.deletedCount,
      skipped: paidInvoiceIds.size + notLastSkipped,
    });
  } catch (error) {
    sendError(res, error);
  }
};


const importInvoices = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.invoices;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0)
      return res.status(400).json({ message: "No valid invoice data provided" });

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};
    console.log("[importInvoices] rows received:", rowsRaw.length);

    // Case + space + special-char insensitive field reader
    const normalizeKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9#]/g, "");
    const buildKeyMap  = (r) => new Map(Object.keys(r).map(k => [normalizeKey(k), k]));
    const getVal = (r, km, ...names) => {
      for (const name of names) {
        const ak = km.get(normalizeKey(name));
        if (ak !== undefined && r[ak] !== undefined && r[ak] !== null && r[ak] !== "") return r[ak];
      }
      return "";
    };

    // Safe date parser: handles JS Date objects (from XLSX cellDates:true), Excel serials, strings
    const parseDate = (v) => {
      if (!v) return null;
      if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
      const n = Number(v);
      if (!isNaN(n) && n > 40000 && n < 60000) return new Date((n - 25569) * 86400 * 1000);

      // Handle DD-MM-YYYY or DD/MM/YYYY strings explicitly since new Date() fails on them
      if (typeof v === "string") {
        const parts = v.split(/[-/]/);
        if (parts.length === 3 && parts[0].length === 2 && parts[2].length === 4) {
          // It's DD-MM-YYYY
          const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          if (!isNaN(d.getTime())) return d;
        }
      }

      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    const parseNum = (v) => {
      if (v === undefined || v === null || v === "") return 0;
      return Number(String(v).replace(/[^0-9.-]+/g, "")) || 0;
    };

    const STATUS_MAP = {
      unpaid: "unpaid", paid: "paid",
      "partially paid": "partially_paid", partially_paid: "partially_paid",
      overdue: "overdue", cancelled: "cancelled", canceled: "cancelled",
      draft: "draft", sent: "sent", "sent later": "sent_later",
      sent_later: "sent_later", recorded: "recorded",
    };
    const normalizeStatus = (s) => (s && STATUS_MAP[String(s).toLowerCase().trim()]) || "unpaid";

    // Build key maps for all rows
    const keyMaps = rowsRaw.map(r => buildKeyMap(r));
    const getCompany = (r, km) =>
      getVal(r, km, "Party Name", "Customer", "Company Name", "company", "Company");

    // Batch-fetch existing clients
    const companyNames = [...new Set(rowsRaw.map((r, i) => getCompany(r, keyMaps[i])).filter(Boolean))];
    const clientDocs = companyNames.length
      ? await Client.find({ company: { $in: companyNames.map(c => new RegExp(`^${escapeRegExp(String(c).trim())}$`, "i")) }, ...tenantFilter })
      : [];
    const clientMap = new Map(clientDocs.map(c => [c.company.toLowerCase().trim(), c]));

    // Auto-create missing clients so no row is skipped
    const missingNames = companyNames.filter(n => !clientMap.has(n.toLowerCase().trim()));
    if (missingNames.length) {
      const created = await Client.insertMany(
        missingNames.map(name => ({ company: name, tenant_id: tenantId })),
        { ordered: false }
      ).catch(() => []);
      for (const c of created) clientMap.set(c.company.toLowerCase().trim(), c);
      for (const name of missingNames) {
        if (!clientMap.has(name.toLowerCase().trim())) {
          const f = await Client.findOne({ company: new RegExp(`^${escapeRegExp(String(name).trim())}$`, "i"), ...tenantFilter });
          if (f) clientMap.set(name.toLowerCase().trim(), f);
        }
      }
    }

    // Group rows by invoice/voucher number (multiple rows = line items on same invoice)
    const groups = new Map();
    let skippedNoClient = 0;
    let skippedInvalid = 0; // rows with a negative qty, rate, GST % or freight
    let autoCounter = 0;

    for (let i = 0; i < rowsRaw.length; i++) {
      const r = rowsRaw[i];
      const km = keyMaps[i];
      const companyName = getCompany(r, km).toLowerCase().trim();
      let clientObj = clientMap.get(companyName);

      if (!clientObj) {
        if (companyName) {
          try {
            clientObj = await Client.create({ company: companyName, tenant_id: tenantId });
            clientMap.set(companyName, clientObj);
          } catch {
            clientObj = await Client.findOne({ company: new RegExp(`^${escapeRegExp(companyName)}$`, "i"), ...tenantFilter });
            if (clientObj) { clientMap.set(companyName, clientObj); }
          }
        }
        if (!clientObj) { skippedNoClient++; continue; }
      }

      const clientId = clientObj._id;

      const rawNum  = getVal(r, km, "Voucher Number", "Invoice #", "number", "Number");
      const number  = rawNum ? String(rawNum).trim() : `INV-AUTO-${Date.now()}-${autoCounter++}`;
      const rowDate = parseDate(getVal(r, km, "Bill Date", "Date", "date")) || new Date();

      // Rows are merged as line-items of the same invoice only when voucher
      // number, client AND date all match. Two distinct invoices that happen
      // to reuse the same voucher-number text (a genuine duplicate, not more
      // line-items) must stay separate, or the second invoice's items would
      // silently get appended onto the first invoice's client/date/meta.
      const groupKey = rawNum
        ? `${String(rawNum).trim()}|${clientId}|${rowDate.toISOString().slice(0, 10)}`
        : `auto-${autoCounter}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          meta: {
            client:         clientId,
            number,
            voucherType:    String(getVal(r, km, "Voucher Type",       "voucherType")     || ""),
            partyAddress:   String(getVal(r, km, "Party Address",      "partyAddress")    || ""),
            partyGroup:     String(getVal(r, km, "Party Group",        "partyGroup")      || ""),
            termsOfPayment: String(getVal(r, km, "Terms of Payment",   "termsOfPayment")  || ""),
            gstin:          String(getVal(r, km, "GSTIN/UIN", "GSTIN", "gstin")           || ""),
            date:           rowDate,
            duedate:        parseDate(getVal(r, km, "Due Date", "duedate", "due_date"))   || undefined,
            status:         normalizeStatus(getVal(r, km, "Status", "status")),
            // "Branch Name" (with or without a leading/trailing space, as Tally
            // Sales Register exports use) must match too — not just "Branch".
            branch:         String(getVal(r, km, "Branch", "branch", "Branch Name", "branchName") || ""),
            salesPerson:    String(getVal(r, km, "Sales Person", "SALES PERSON", "salesPerson", "Salesperson") || ""),
          },
          items: [],
        });
      }

      // No Quantity column/value = 1; an explicit 0 stays 0 (same as the form).
      const rawQty = getVal(r, km, "Quantity", "quantity", "qty");
      const qty    = rawQty === "" ? 1 : parseNum(rawQty);
      const rate   = parseNum(getVal(r, km, "Rate", "rate"));
      const rawAmt = getVal(r, km, "Amount", "amount");
      const amount = rawAmt !== "" ? parseNum(rawAmt) : qty * rate;
      const gstPercentage = parseNum(getVal(r, km, "GST percentage", "GST Percentage", "GST persentage", "gstPercentage"));
      // Optional column, read as a percentage of qty*rate — same rule Invoice
      // Create uses for the Freight % field — not a flat rupee amount. A sheet
      // with no Freight % column simply imports at 0 freight, same as leaving
      // the field blank in Invoice Create.
      const freightPct = parseNum(getVal(r, km, "Freight %", "Freight Percentage", "Freight Charge", "Freight", "freight_charge"));
      const freight_charge = Math.round(qty * rate * (freightPct / 100) * 100) / 100;
      if (qty < 0 || rate < 0 || gstPercentage < 0 || freightPct < 0) { skippedInvalid++; continue; }

      groups.get(groupKey).items.push({
        description:   String(getVal(r, km, "Item Name", "description", "item") || "Imported Item"),
        itemGroup:     String(getVal(r, km, "Item Group",     "itemGroup")    || ""),
        itemHSN:       String(getVal(r, km, "Item HSN",       "itemHSN")      || ""),
        itemBatch:     String(getVal(r, km, "Item Batch",     "itemBatch")    || ""),
        unit:          String(getVal(r, km, "Unit",           "unit")         || ""),
        gstPercentage,
        // `tax` is the field every invoice view actually reads (create/edit
        // already normalizes into this field) — without it, imported items
        // show "0%" in the Tax column even though gstPercentage is set.
        tax: gstPercentage,
        tax_name: gstPercentage ? `GST ${gstPercentage}%` : "",
        qty, rate, amount, freight_charge,
      });
    }

    for (const [key, g] of groups) if (g.items.length === 0) groups.delete(key);
    if (groups.size === 0) {
      return res.status(400).json({
        message: skippedNoClient > 0
          ? `No importable rows — ${skippedNoClient} row(s) had no recognisable Company/Party Name.`
          : "No importable rows. Ensure your file has a 'Party Name' or 'Company Name' column.",
      });
    }

    const rows = [...groups.values()].map(({ meta, items }) => {
      const clientObj = [...clientMap.values()].find(c => String(c._id) === String(meta.client));
      const totals = InvoiceService.calculateTotals({ items }, withInvoiceGstin(clientObj, meta.gstin), homeStateFor(req.user));
      return {
        ...meta,
        subtotal: totals.subtotal,
        total_tax: totals.totalTax,
        total: totals.total,
        discount_total: totals.discount_total,
        tax_type: totals.tax_type,
        total_cgst: totals.total_cgst,
        total_sgst: totals.total_sgst,
        total_igst: totals.total_igst,
        tenant_id: tenantId,
        created_by: req.user?._id,
        items
      };
    });

    // Duplicate voucher numbers must never fail/skip the import — auto-append
    // a (n) suffix instead. Gap-aware across both existing DB records and
    // other duplicates within this same batch: if 10 and 10(1) already exist,
    // the next one assigned is 10(2). Scoped per-tenant, same as the rest of
    // this import.
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const SUFFIX_RE = /^(.*)\((\d+)\)$/;

    const realBases = [...new Set(rows.map(r => r.number).filter(n => n && !n.startsWith("INV-AUTO-")))];
    const existingDocs = realBases.length
      ? await Invoice.find({
          ...tenantFilter,
          $or: realBases.map(b => ({ number: { $regex: `^${escapeRegex(b)}(\\(\\d+\\))?$` } })),
        }).select("number").lean()
      : [];

    const maxSuffixByBase = new Map();
    const takenNumbers = new Set();
    for (const doc of existingDocs) {
      takenNumbers.add(doc.number);
      const m = doc.number.match(SUFFIX_RE);
      const base = m ? m[1] : doc.number;
      const suffix = m ? parseInt(m[2], 10) : 0;
      if (suffix > (maxSuffixByBase.get(base) ?? -1)) maxSuffixByBase.set(base, suffix);
    }

    let renamedCount = 0;
    const toInsert = rows.map((r) => {
      if (!r.number || r.number.startsWith("INV-AUTO-")) return r;
      const base = r.number;
      if (!takenNumbers.has(base)) {
        takenNumbers.add(base);
        return r;
      }
      const next = (maxSuffixByBase.get(base) ?? 0) + 1;
      maxSuffixByBase.set(base, next);
      renamedCount++;
      return { ...r, number: `${base}(${next})` };
    });

    console.log("[importInvoices] to insert:", toInsert.length, "| renamed for duplicate voucher #:", renamedCount, "| no-client skipped:", skippedNoClient);

    let result = [];
    const insertErrors = [];
    try {
      result = await Invoice.insertMany(toInsert, { ordered: false });
    } catch (bulkErr) {
      result = bulkErr.insertedDocs || [];
      const writeErrors = bulkErr.writeErrors || [];
      writeErrors.forEach((we) => {
        const reason = `Voucher "${toInsert[we.index]?.number}" failed to insert: ${we.errmsg || we.err?.errmsg || "unknown error"}`;
        insertErrors.push(reason);
        console.error(`[importInvoices] ${reason}`);
      });
      if (!writeErrors.length) console.error("[importInvoices] bulk insert error:", bulkErr.message);
    }
    console.log("[importInvoices] inserted:", result.length);

    res.status(201).json({
      message: `Imported ${result.length} invoice(s).${renamedCount ? ` ${renamedCount} had a duplicate voucher number and were renamed with a (n) suffix.` : ""}${skippedNoClient ? ` ${skippedNoClient} row(s) skipped (no company match).` : ""}${skippedInvalid ? ` ${skippedInvalid} row(s) skipped (negative quantity, rate, GST or freight).` : ""}${insertErrors.length ? ` ${insertErrors.length} row(s) failed to insert — see server log.` : ""}`,
      count: result.length,
      renamed: renamedCount,
      skipped: skippedNoClient + skippedInvalid,
      failed: insertErrors.length,
    });
  } catch (error) {
    console.error("IMPORT INVOICES ERROR:", error);
    sendError(res, error);
  }
};

// ── Send Invoice to Email ────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DEFAULT_INVOICE_EMAIL = {
  subject: "Invoice {invoice_number} from {company_name}",
  message: "Hello {contact_name},\n\nPlease find attached invoice {invoice_number}.\n\nTotal due: {invoice_total}\nDue date: {invoice_duedate}\n\n{email_signature}",
};
const MAX_PDF_BYTES = 7 * 1024 * 1024;

const toEmailList = (value) =>
  [...new Set((Array.isArray(value) ? value : String(value || "").split(/[,;\s]+/)).map((e) => String(e).trim()).filter(Boolean))];

const ddmmyyyy = (d) => {
  if (!d) return "—";
  const x = new Date(d);
  return isNaN(x.getTime()) ? "—" : `${String(x.getDate()).padStart(2, "0")}-${String(x.getMonth() + 1).padStart(2, "0")}-${x.getFullYear()}`;
};

// GET /api/invoices/:id/email-draft — To / Subject / Message the Send dialog starts with.
const getInvoiceEmailDraft = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const invoice = await Invoice.findOne({ _id: req.params.id, ...invoiceScope(req) }).populate("client", "company contact_person email").lean();
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const Contact = require("../models/Contact");
    const EmailTemplate = require("../models/EmailTemplate");
    const Currency = require("../models/Currency");
    const Tenant = require("../models/Tenant");
    const Staff = require("../models/Staff");

    const contacts = invoice.client
      ? await Contact.find({ userid: invoice.client._id, active: { $ne: false }, invoice_emails: { $ne: false }, email: { $nin: [null, ""] } })
        .sort({ is_primary: -1 }).select("firstname lastname email").lean()
      : [];
    const to = toEmailList(contacts.map((c) => c.email)).filter((e) => EMAIL_RE.test(e));
    if (!to.length && EMAIL_RE.test(invoice.client?.email || "")) to.push(invoice.client.email);
    const primary = contacts[0];

    const [template, currency, tenant, me] = await Promise.all([
      EmailTemplate.findOne({ module: "Invoices", name: "Send Invoice to Customer", active: { $ne: false } }).lean(),
      Currency.findOne({ tenant_id: invoice.tenant_id, name: invoice.currency }).select("symbol").lean(),
      invoice.tenant_id ? Tenant.findById(invoice.tenant_id).select("company_name").lean() : null,
      Staff.findById(req.user._id).select("firstname lastname email_signature").lean(),
    ]);
    const companyName = tenant?.company_name || "";
    const values = {
      contact_name: primary ? `${primary.firstname || ""} ${primary.lastname || ""}`.trim() : invoice.client?.contact_person || invoice.client?.company || "Customer",
      invoice_number: invoice.number,
      invoice_total: `${currency?.symbol || ""}${(Number(invoice.total) || 0).toFixed(2)}`,
      invoice_duedate: ddmmyyyy(invoice.duedate),
      invoice_date: ddmmyyyy(invoice.date),
      company_name: companyName,
      client_company: invoice.client?.company || "",
      email_signature: me?.email_signature || [`${me?.firstname || ""} ${me?.lastname || ""}`.trim(), companyName].filter(Boolean).join("\n"),
    };
    const fill = (text) => String(text || "").replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));
    res.json({
      to,
      subject: fill(template?.subject || DEFAULT_INVOICE_EMAIL.subject),
      message: fill(template?.message || DEFAULT_INVOICE_EMAIL.message),
      filename: `Invoice_${String(invoice.number).replace(/[^\w.-]+/g, "_")}.pdf`,
    });
  } catch (error) {
    sendError(res, error);
  }
};

// POST /api/invoices/:id/send-email { to, cc, subject, message, pdf_base64 }
// Sends through the company's own SMTP, logs it and marks an unpaid / draft invoice as "sent".
const sendInvoiceEmail = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const invoice = await Invoice.findOne({ _id: req.params.id, ...invoiceScope(req) });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const to = toEmailList(req.body?.to);
    const cc = toEmailList(req.body?.cc);
    const subject = String(req.body?.subject || "").trim();
    const message = String(req.body?.message || "").trim();
    if (!to.length) return res.status(400).json({ message: "Please enter at least one email address in To." });
    const bad = [...to, ...cc].find((e) => !EMAIL_RE.test(e));
    if (bad) return res.status(400).json({ message: `"${bad}" is not a valid email address.` });
    if (to.length + cc.length > 20) return res.status(400).json({ message: "You can send to at most 20 email addresses at once." });
    if (!subject || subject.length > 300) return res.status(400).json({ message: "Subject is required (max 300 characters)." });
    if (!message || message.length > 20000) return res.status(400).json({ message: "Message is required (max 20000 characters)." });

    const attachments = [];
    if (req.body?.pdf_base64) {
      const pdf = Buffer.from(String(req.body.pdf_base64), "base64");
      if (pdf.subarray(0, 5).toString() !== "%PDF-") return res.status(400).json({ message: "The attachment is not a valid PDF." });
      if (pdf.length > MAX_PDF_BYTES) return res.status(400).json({ message: "The PDF is too large to email (max 7 MB)." });
      attachments.push({ filename: `Invoice_${String(invoice.number).replace(/[^\w.-]+/g, "_")}.pdf`, content: pdf, contentType: "application/pdf" });
    }

    try {
      await require("../services/EmailService").sendMail({ tenantId: invoice.tenant_id, to, cc, subject, text: message, attachments });
    } catch (mailErr) {
      const notSetUp = /SMTP not configured/.test(mailErr.message);
      return res.status(notSetUp ? 400 : 502).json({ message: notSetUp ? mailErr.message : `Email could not be sent: ${mailErr.message}` });
    }

    invoice.email_log.push({ to, cc, subject, pdf_attached: attachments.length > 0, sent_at: new Date(), sent_by: req.user._id });
    if (["unpaid", "draft", "sent_later"].includes(invoice.status)) invoice.status = "sent";
    await invoice.save({ validateBeforeSave: false });
    logActivity(req, `Emailed invoice ${invoice.number} to ${to.join(", ")}`, { rel_id: invoice._id, rel_type: "invoice" });
    res.json({ message: `Invoice sent to ${to.join(", ")}`, status: invoice.status, email_log: invoice.email_log });
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = { getInvoices, getInvoiceById, createInvoice, updateInvoice, deleteInvoice, importInvoices, getInvoiceBranches, bulkDeleteInvoices, getNextInvoiceNumber, getInvoiceEmailDraft, sendInvoiceEmail };
