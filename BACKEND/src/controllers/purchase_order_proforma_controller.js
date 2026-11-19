// Proforma Invoice (R5): after an approver says Yes to a Purchase PO,
// "Create Proforma Invoice" makes a proforma for the PO's CUSTOMER — same
// lines at the customer's selling price (whole rupees, Q3), Disc %, IGST or
// CGST + SGST, freight / packing lines, advance → balance payable, amount in
// words, and the company's own seller block, bank details and commercial
// terms from PO Settings (Q4). The browser builds the PDF in the client's
// proforma layout (F3) and can send it on WhatsApp to the customer.
//
// Lives inside the Purchase Orders add-on: same tenant gate and permissions
// (purchase_order_routes.js). Linked both ways: proforma.po, and the PO's
// GET lists its proformas.
const mongoose = require("mongoose");
const PurchaseOrder = require("../models/PurchaseOrder");
const PoSettings = require("../models/PoSettings");
const ProformaInvoice = require("../models/ProformaInvoice");
const ActivityLog = require("../models/ActivityLog");
const { fyOf, rupee } = require("../services/purchaseOrderRules");
const { computeProforma, amountInWords, round2, TAX_TYPES } = require("../services/proformaMath");
const { _internal: H } = require("./purchase_order_controller");
const V = require("../services/poValidation");

const { httpError, fail, plain, can, tenantOf, loadPo, getSettingsDoc, effectiveCompany, SENDABLE, escapeRegExp, queryText, bodyDate, deliverPdf, activeIntegration, assertPdf } = H;

const scope = async (req) => {
  const filter = { tenant_id: tenantOf(req) };
  if (req.permissionLevel === "own" && !(await can(req, "Approve"))) filter.created_by = req.user._id;
  return filter;
};

const loadProforma = async (req, id) => {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, "Proforma invoice not found");
  const pf = await ProformaInvoice.findOne({ _id: id, ...(await scope(req)) });
  if (!pf) throw httpError(404, "Proforma invoice not found");
  return pf;
};

const record = (req, doc, action, note) => doc.history.push({ action, by: req.user._id, at: new Date(), note: note || undefined });

const logActivity = (req, pf, verb, note) => {
  ActivityLog.create({
    description: `Proforma invoice ${pf.number} (PO ${pf.po_number}) ${verb}${note ? ` — ${note}` : ""}`,
    staffid: req.user._id,
    rel_id: pf._id,
    rel_type: "proforma_invoice",
    tenant_id: pf.tenant_id,
  }).catch((err) => console.error("[proforma] activity log failed:", err.message));
};

// Recomputes lines, totals and the words from what is on the proforma.
const recompute = (pf) => {
  const { lines, totals } = computeProforma({ lines: plain(pf).lines, taxType: pf.tax_type, advance: pf.totals?.advance || 0 });
  if (totals.advance > totals.grand_total) throw httpError(400, "Advance received can't be more than the grand total");
  pf.lines = lines;
  pf.totals = totals;
  pf.amount_in_words = amountInWords(totals.grand_total);
};

// "<prefix>0197", running per financial year (atomic counter, no unique index).
const nextProformaNumber = async (settings, date) => {
  const fy = fyOf(date);
  const key = `proforma_${fy}`;
  const updated = await PoSettings.findOneAndUpdate({ _id: settings._id }, { $inc: { [`counters.${key}`]: 1 } }, { new: true });
  return { number: `${settings.proforma?.prefix || ""}${String(updated.counters.get(key)).padStart(4, "0")}`, fy };
};

const sameState = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// IGST when the customer is in another state than the seller; CGST + SGST in
// the same state. Unknown state → what the PO used.
const defaultTaxType = (seller, billTo, po) => {
  if (seller?.state && billTo?.state) return sameState(seller.state, billTo.state) ? "cgst_sgst" : "igst";
  return po.tax_mode === "intra" ? "cgst_sgst" : "igst";
};

// POST /:id/proforma — from an approved (or later) Purchase PO with a customer.
// A second one for the same PO asks first: 409 { code: "proforma_exists" }
// unless the body says { again: true }.
const createProforma = async (req, res) => {
  try {
    if (!(await can(req, "Create")) && !(await can(req, "Edit"))) throw httpError(403, "You don't have permission to make proforma invoices");
    const po = await loadPo(req, req.params.id);
    if (po.type !== "purchase") throw httpError(400, "Old Sales POs are read-only (Sales PO was removed)");
    if (!SENDABLE.includes(po.status)) throw httpError(400, "A proforma can only be made after the PO is approved");
    if (!po.customer_snapshot?.name) throw httpError(400, "This PO has no customer — a proforma invoice needs one");
    const existing = await ProformaInvoice.find({ tenant_id: po.tenant_id, po: po._id, status: { $ne: "cancelled" } }).select("number").lean();
    if (existing.length && req.body?.again !== true) {
      return res.status(409).json({
        code: "proforma_exists",
        message: `Proforma ${existing.map((e) => e.number).join(", ")} already exists for this PO. Make another one?`,
        existing: existing.map((e) => ({ _id: e._id, number: e.number })),
      });
    }

    const settings = await getSettingsDoc(po.tenant_id);
    const seller = await effectiveCompany(settings);
    const billTo = { ...(plain(po).customer_snapshot || {}) };
    const date = new Date();
    const validDays = settings.proforma?.valid_days ?? 15;
    const pf = new ProformaInvoice({
      tenant_id: po.tenant_id,
      po: po._id,
      po_number: po.po_number,
      ...(await nextProformaNumber(settings, date)),
      date,
      valid_until: new Date(date.getTime() + validDays * 86400000),
      customer: po.customer,
      bill_to: billTo,
      customer_po_number: po.customer_po_number,
      customer_po_date: po.customer_po_date,
      tax_type: defaultTaxType(seller, billTo, po),
      // Same lines as the PO, at the customer's selling price.
      lines: po.items.map((l) => ({
        item_id: l.item_id,
        ref_no: l.item_code || "",
        description: l.y_code || l.name,
        hsn: l.hsn || "",
        qty: l.qty,
        unit: l.unit || "Nos",
        rate: rupee(l.selling_price),
        disc_pct: 0,
        gst_pct: l.tax_rate ?? 18,
      })),
      totals: { advance: 0 },
      seller,
      created_by: req.user._id,
    });
    recompute(pf);
    record(req, pf, "created", `from PO ${po.po_number}`);
    await pf.save();
    await PurchaseOrder.updateOne({ _id: po._id }, { $push: { history: { action: "proforma_created", by: req.user._id, at: new Date(), note: pf.number } } });
    logActivity(req, pf, "created");
    ActivityLog.create({
      description: `Purchase PO ${po.po_number} proforma invoice created — ${pf.number}`,
      staffid: req.user._id,
      rel_id: po._id,
      rel_type: "purchase_order",
      tenant_id: po.tenant_id,
    }).catch((err) => console.error("[proforma] activity log failed:", err.message));
    res.status(201).json(pf);
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

const listProformas = async (req, res) => {
  try {
    const filter = await scope(req);
    const status = queryText(req.query.status);
    if (req.query.status !== undefined && req.query.status !== "" && req.query.status !== "all") {
      if (!["draft", "sent", "cancelled"].includes(status)) throw httpError(400, "Invalid status filter");
      filter.status = status;
    }
    if (req.query.po !== undefined) {
      if (!mongoose.isValidObjectId(req.query.po)) throw httpError(400, "Invalid PO filter");
      filter.po = req.query.po;
    }
    const search = queryText(req.query.search);
    if (search) {
      const re = new RegExp(escapeRegExp(search), "i");
      filter.$or = [{ number: re }, { po_number: re }, { "bill_to.name": re }, { customer_po_number: re }];
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const [total, data] = await Promise.all([
      ProformaInvoice.countDocuments(filter),
      ProformaInvoice.find(filter)
        .select("number fy date valid_until po po_number bill_to.name customer_po_number totals status createdAt")
        .populate("po", "po_number status")
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);
    res.json({ data, total, page, pages: Math.max(Math.ceil(total / limit), 1), limit });
  } catch (error) {
    fail(res, error);
  }
};

const populated = (id) =>
  ProformaInvoice.findById(id)
    .populate("po", "po_number status")
    .populate("created_by", "firstname lastname email")
    .populate("history.by", "firstname lastname")
    .populate("whatsapp_log.by", "firstname lastname");

const getProforma = async (req, res) => {
  try {
    const pf = await loadProforma(req, req.params.pid);
    res.json(await populated(pf._id));
  } catch (error) {
    fail(res, error);
  }
};

const pct = (v, label) => {
  const n = H.lineAmount(v, label, 100);
  return n;
};

const PARTY_FIELDS = ["name", "address", "gstin", "state", "email", "phone", "whatsapp"];

// PUT /proformas/:pid — a draft only. The PO's lines keep their qty and rate
// (only Disc % and GST % change); freight / packing lines are sent in full.
const updateProforma = async (req, res) => {
  try {
    const pf = await loadProforma(req, req.params.pid);
    const own = String(pf.created_by) === String(req.user._id) && (await can(req, "Create"));
    if (!own && !(await can(req, "Edit"))) throw httpError(403, "You don't have permission to change this proforma");
    if (pf.status !== "draft") throw httpError(400, pf.status === "sent" ? "A sent proforma is locked" : "This proforma is cancelled");
    const b = req.body || {};

    if (b.date !== undefined) pf.date = bodyDate(b.date, "Date") || pf.date;
    if (b.valid_until !== undefined) pf.valid_until = bodyDate(b.valid_until, "Valid until");
    if (pf.valid_until && pf.valid_until < new Date(new Date(pf.date).setHours(0, 0, 0, 0))) throw httpError(400, "Valid until can't be before the proforma date");
    if (b.tax_type !== undefined) {
      if (!TAX_TYPES.includes(b.tax_type)) throw httpError(400, "Tax type must be IGST or CGST + SGST");
      pf.tax_type = b.tax_type;
    }
    if (b.customer_po_number !== undefined) {
      const t = H.check(V.customerPoNo(b.customer_po_number), "customer_po_number");
      pf.customer_po_number = t || undefined;
    }
    if (b.customer_po_date !== undefined) pf.customer_po_date = bodyDate(b.customer_po_date, "Customer PO date");
    if (b.bill_to !== undefined) {
      if (!b.bill_to || typeof b.bill_to !== "object") throw httpError(400, "Bill to: send the fields");
      const next = { ...(plain(pf).bill_to || {}) };
      for (const k of PARTY_FIELDS) {
        const t = H.textField(b.bill_to[k], `Bill to ${k}`, k === "address" ? 1000 : 200);
        if (t !== undefined) next[k] = t;
      }
      if (!next.name) throw httpError(400, "Bill to: the customer name is required", { field: "bill_to.name" });
      // S4 formats (empty = not set).
      next.gstin = H.check(V.gstin(next.gstin, { label: "Bill to GSTIN" }), "bill_to.gstin");
      H.check(V.email(next.email, { label: "Bill to email" }), "bill_to.email");
      H.check(V.phone(next.phone, { label: "Bill to phone" }), "bill_to.phone");
      H.check(V.phone(next.whatsapp, { label: "Bill to WhatsApp" }), "bill_to.whatsapp");
      pf.bill_to = next;
    }
    if (b.notes !== undefined) pf.notes = H.textField(b.notes, "Notes", 3000) || undefined;

    if (b.lines !== undefined) {
      if (!Array.isArray(b.lines)) throw httpError(400, "lines must be a list");
      const current = plain(pf).lines;
      const poLines = current.filter((l) => !l.is_extra);
      const extras = [];
      b.lines.forEach((l, i) => {
        const label = `Line ${i + 1}`;
        if (!l || typeof l !== "object") throw httpError(400, `${label}: not a line`);
        if (l.is_extra) {
          const description = H.textField(l.description, `${label}: description`, 300);
          if (!description) throw httpError(400, `${label}: describe the charge (e.g. Freight / packing)`);
          const qty = H.check(V.quantity(l.qty ?? 1, { label: `${label}: quantity` }), "lines");
          extras.push({
            is_extra: true,
            ref_no: H.textField(l.ref_no, `${label}: ref no.`, 100) || "",
            description,
            hsn: H.check(V.hsn(l.hsn, { label: `${label}: HSN/SAC` }), "lines"),
            qty,
            unit: H.textField(l.unit, `${label}: unit`, 30) || "",
            rate: H.check(V.price(l.rate ?? 0, { label: `${label}: rate` }), "lines"),
            disc_pct: pct(l.disc_pct ?? 0, `${label}: Disc %`),
            gst_pct: pct(l.gst_pct ?? 18, `${label}: GST %`),
          });
          return;
        }
        const line = poLines.find((p) => String(p._id) === String(l._id));
        if (!line) throw httpError(400, `${label}: unknown line`);
        if (l.disc_pct !== undefined) line.disc_pct = pct(l.disc_pct, `${label}: Disc %`);
        if (l.gst_pct !== undefined) line.gst_pct = pct(l.gst_pct, `${label}: GST %`);
      });
      if (extras.length > 20) throw httpError(400, "At most 20 extra lines");
      pf.lines = [...poLines, ...extras];
    }
    if (b.advance !== undefined) {
      const adv = b.advance === null ? 0 : H.check(V.price(b.advance, { label: "Advance received" }), "advance");
      pf.totals = { ...plain(pf).totals, advance: round2(adv ?? 0) };
    }
    recompute(pf);
    record(req, pf, "edited");
    await pf.save();
    logActivity(req, pf, "edited");
    res.json(await populated(pf._id));
  } catch (error) {
    fail(res, error.name === "ValidationError" ? httpError(400, error.message) : error);
  }
};

const cancelProforma = async (req, res) => {
  try {
    if (!(await can(req, "Edit"))) throw httpError(403, "You don't have permission to cancel proforma invoices");
    const pf = await loadProforma(req, req.params.pid);
    if (pf.status === "cancelled") throw httpError(400, "This proforma is already cancelled");
    pf.status = "cancelled";
    record(req, pf, "cancelled", typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) : "");
    await pf.save();
    logActivity(req, pf, "cancelled");
    res.json(await populated(pf._id));
  } catch (error) {
    fail(res, error);
  }
};

// Everything the browser needs for the proforma PDF (F3 layout).
const getProformaPrint = async (req, res) => {
  try {
    const pf = await loadProforma(req, req.params.pid);
    res.json({ proforma: plain(pf) });
  } catch (error) {
    fail(res, error);
  }
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN") : "");

// The WhatsApp template's body values may use the same placeholders as POs.
const proformaParams = (pf) => (text) => {
  const values = {
    po_number: pf.number,
    po_date: fmtDate(pf.date),
    expected_date: fmtDate(pf.valid_until),
    party_name: pf.bill_to?.name || "",
    "customer.name": pf.bill_to?.name || "",
    "supplier.name": pf.seller?.name || "",
    customer_po_number: pf.customer_po_number || "",
    grand_total: (pf.totals?.grand_total || 0).toFixed(2),
  };
  return String(text || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
};

// POST /proformas/:pid/whatsapp — the browser-made proforma PDF to the customer.
const sendProformaWhatsApp = async (req, res) => {
  try {
    if (!(await can(req, "Edit"))) throw httpError(403, "You don't have permission to send proforma invoices");
    const pf = await loadProforma(req, req.params.pid);
    if (pf.status === "cancelled") throw httpError(400, "This proforma is cancelled");
    assertPdf(req.file, "The proforma PDF is missing");
    const integration = await activeIntegration(pf.tenant_id);
    const digits = String(req.body?.to || pf.bill_to?.whatsapp || pf.bill_to?.phone || "").replace(/\D/g, "");
    if (digits.length < 10) throw httpError(400, "This customer has no phone number — type the WhatsApp number to send to");

    const filename = `Proforma-${String(pf.number).replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
    const { result, log, at } = await deliverPdf({
      req,
      integration,
      tenantId: pf.tenant_id,
      to: digits,
      buffer: req.file.buffer,
      filename,
      caption: `Proforma invoice ${pf.number}`,
      params: proformaParams(pf),
    });
    const note = { action: "whatsapp", by: req.user._id, at, note: `to ${digits}${result.skipped ? " (test mode)" : ""}` };
    await ProformaInvoice.updateOne({ _id: pf._id }, { $push: { whatsapp_log: log, ...(result.success ? { history: note } : {}) } });
    if (result.success) await ProformaInvoice.updateOne({ _id: pf._id, status: "draft" }, { $set: { status: "sent" } });
    const saved = await populated(pf._id);
    if (!result.success) return res.status(400).json({ message: result.error, proforma: saved });
    logActivity(req, saved, "sent on WhatsApp", `to ${digits}`);
    res.json(saved);
  } catch (error) {
    fail(res, error);
  }
};

module.exports = {
  createProforma,
  listProformas,
  getProforma,
  updateProforma,
  cancelProforma,
  getProformaPrint,
  sendProformaWhatsApp,
  defaultTaxType,
};
