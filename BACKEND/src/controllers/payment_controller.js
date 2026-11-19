const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const Client = require("../models/Client");
const InvoiceService = require("../services/InvoiceService");
const { logActivity } = require("../services/ActivityLogService");
const mongoose = require("mongoose");

// Payments of the user's own company only.
const paymentScope = (req) => {
  const scope = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) scope.tenant_id = req.user.tenant_id;
  return scope;
};

const PAYMENT_FIELDS = ["invoice", "client", "branch", "amount", "paymentmode", "paymentmethod", "date", "transactionid", "companyName", "voucherNumber", "billDate", "journal", "note"];

const sendError = (res, error) =>
  res.status(error?.name === "CastError" || error?.name === "ValidationError" ? 400 : 500).json({ message: error.message });

// Amount must be a positive number and, for an invoice payment, not more than
// what is still due on that invoice (excluding `ignorePaymentId` when editing).
const checkAmount = async (amount, invoice, ignorePaymentId) => {
  if (amount === undefined || amount === null || amount === "" || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return "Enter a valid payment amount.";
  }
  if (!invoice) return null;
  const others = await Payment.find({ invoice: invoice._id, ...(ignorePaymentId && { _id: { $ne: ignorePaymentId } }) }).select("amount").lean();
  const due = Math.round(((Number(invoice.total) || 0) - others.reduce((s, p) => s + (Number(p.amount) || 0), 0)) * 100) / 100;
  if (Number(amount) > due + 0.005) return `Amount is more than the balance due (${Math.max(due, 0)}).`;
  return null;
};

// A "Credit Note" payment was removed: give the amount back to the credit note
// it came from (and re-open it), so the credit can be used again.
const restoreCredit = async (payment) => {
  if (payment.paymentmode !== "Credit Note" || !payment.invoice) return;
  const CreditNote = require("../models/CreditNote");
  const number = String(payment.paymentmethod || "").replace(/^Applied Credit Note /, "");
  const cn = await CreditNote.findOne({
    tenant_id: payment.tenant_id ?? null,
    ...(payment.credit_note ? { _id: payment.credit_note } : { number }),
    "invoices_credited.invoice": payment.invoice,
  });
  if (!cn) return;
  const idx = cn.invoices_credited.findIndex(
    (c) => String(c.invoice) === String(payment.invoice) && Number(c.amount) === Number(payment.amount)
  );
  if (idx === -1) return;
  cn.invoices_credited.splice(idx, 1);
  if (cn.status === 2 && cn.remaining_amount > 0) cn.status = 1; // Closed -> Open
  await cn.save();
};

const createPayment = async (req, res) => {
  try {
    const data = Object.fromEntries(PAYMENT_FIELDS.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]]));
    let invoice = null;
    if (data.invoice) {
      if (!mongoose.isValidObjectId(data.invoice)) return res.status(400).json({ message: "Invalid invoice" });
      invoice = await Invoice.findOne({ _id: data.invoice, tenant_id: req.user?.tenant_id ?? null });
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    }
    if (data.client) {
      if (!mongoose.isValidObjectId(data.client) || !(await Client.exists({ _id: data.client, tenant_id: req.user?.tenant_id ?? null }))) {
        return res.status(400).json({ message: "Customer not found" });
      }
    }
    const invalid = await checkAmount(data.amount, invoice);
    if (invalid) return res.status(400).json({ message: invalid });
    if (data.date !== undefined && isNaN(new Date(data.date).getTime())) return res.status(400).json({ message: "Invalid payment date" });
    if (invoice) {
      if (!String(data.paymentmode || "").trim()) return res.status(400).json({ message: "Please select a payment mode." });
      if (data.date && invoice.date && new Date(data.date) < new Date(new Date(invoice.date).toDateString())) {
        return res.status(400).json({ message: "Payment date cannot be before the invoice date." });
      }
      if (invoice.status === "cancelled") return res.status(400).json({ message: "Cannot record a payment on a cancelled invoice." });
    }

    const payment = await Payment.create({ ...data, created_by: req.user?._id, tenant_id: req.user?.tenant_id });
    if (payment) {
      // Update invoice status (voucher-style payments may have no linked invoice)
      if (payment.invoice) await InvoiceService.updateStatus(payment.invoice);
      logActivity(req, `Recorded payment of ${payment.amount}`, { rel_id: payment._id, rel_type: "payment" });
      res.status(201).json(payment);
    } else {
      res.status(400).json({ message: "Invalid payment data" });
    }
  } catch (error) {
    sendError(res, error);
  }
};

const updatePayment = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid payment id" });
    const payment = await Payment.findOne({ _id: req.params.id, ...paymentScope(req) });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const { amount, paymentmode, paymentmethod, date, transactionid, note, companyName, voucherNumber, billDate, journal } = req.body;
    if (amount !== undefined) {
      const invoice = payment.invoice ? await Invoice.findById(payment.invoice) : null;
      const invalid = await checkAmount(amount, invoice, payment._id);
      if (invalid) return res.status(400).json({ message: invalid });
    }
    Object.assign(payment, {
      ...(amount !== undefined && { amount }),
      ...(paymentmode !== undefined && { paymentmode }),
      ...(paymentmethod !== undefined && { paymentmethod }),
      ...(date !== undefined && { date }),
      ...(transactionid !== undefined && { transactionid }),
      ...(note !== undefined && { note }),
      ...(companyName !== undefined && { companyName }),
      ...(voucherNumber !== undefined && { voucherNumber }),
      ...(billDate !== undefined && { billDate }),
      ...(journal !== undefined && { journal }),
    });
    await payment.save();

    if (payment.invoice) await InvoiceService.updateStatus(payment.invoice);
    logActivity(req, `Updated payment of ${payment.amount}`, { rel_id: payment._id, rel_type: "payment" });

    res.json(payment);
  } catch (error) {
    sendError(res, error);
  }
};

const deletePayment = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid payment id" });
    const payment = await Payment.findOneAndDelete({ _id: req.params.id, ...paymentScope(req) });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    await restoreCredit(payment);
    if (payment.invoice) await InvoiceService.updateStatus(payment.invoice);
    logActivity(req, `Deleted payment of ${payment.amount}`, { rel_type: "payment" });

    res.json({ message: "Payment deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// payment from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large payment lists. Every distinct invoice touched
// still gets its status recomputed, same as the single-delete endpoint.
const bulkDeletePayments = async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
    if (ids.length === 0) return res.status(400).json({ message: "No payment ids provided" });

    const query = { _id: { $in: ids }, ...paymentScope(req) };

    const matched = await Payment.find(query).lean();
    const matchedIds = matched.map((m) => m._id);
    const affectedInvoiceIds = [...new Set(matched.map((m) => m.invoice).filter(Boolean).map(String))];

    const result = matchedIds.length
      ? await Payment.deleteMany({ _id: { $in: matchedIds } })
      : { deletedCount: 0 };
    for (const p of matched) await restoreCredit(p);

    await Promise.all(affectedInvoiceIds.map((id) => InvoiceService.updateStatus(id)));

    logActivity(req, `Bulk-deleted ${result.deletedCount} payment(s)`, { rel_type: "payment" });
    res.json({ message: `Deleted ${result.deletedCount} payment(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPaymentsByInvoice = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.invoiceId)) return res.status(400).json({ message: "Invalid invoice id" });
    const payments = await Payment.find({ invoice: req.params.invoiceId, ...paymentScope(req) })
      .populate({
        path: 'invoice',
        populate: { path: 'client', select: 'company address city state zip country' },
        select: 'number total date client'
      })
      .populate('created_by', 'firstname lastname')
      .sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPaymentsByCustomer = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.clientId)) return res.status(400).json({ message: "Invalid customer id" });
    const payments = await Payment.find(paymentScope(req))
      .populate({
        path: 'invoice',
        match: { client: req.params.clientId },
        select: 'number total client'
      })
      .sort({ date: -1 });
    
    // Filter out payments where invoice didn't match (client mismatch)
    const filteredPayments = payments.filter(p => p.invoice !== null);
    res.json(filteredPayments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getPayments = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const { page, limit, search } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    const populateInvoice = {
      path: 'invoice',
      populate: {
        path: 'client',
        select: 'company address city state zip country'
      },
      select: 'number total date client'
    };

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard aggregation, exports) keep getting the full bare array.
    if (!isPaginated) {
      const payments = await Payment.find(filter)
        .populate(populateInvoice)
        .populate('created_by', 'firstname lastname')
        .sort({ createdAt: -1 });
      return res.json(payments);
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const matchingClients = await Client.find({ company: re }).select("_id");
      const matchingInvoices = await Invoice.find({
        $or: [{ number: re }, { client: { $in: matchingClients.map((c) => c._id) } }],
      }).select("_id");
      filter.$or = [
        { transactionid: re },
        { paymentmode: re },
        { companyName: re },
        { voucherNumber: re },
        { journal: re },
        { invoice: { $in: matchingInvoices.map((i) => i._id) } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    // "Total Received" always reflects the whole tenant, independent of the
    // currently active search — matches prior behavior (summed from the
    // full, unfiltered payments list).
    const baseFilter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) baseFilter.tenant_id = req.user.tenant_id;

    const [total, totalAmountAgg, payments] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.aggregate([{ $match: baseFilter }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
      Payment.find(filter)
        .populate(populateInvoice)
        .populate('created_by', 'firstname lastname')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: payments,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      totalAmount: totalAmountAgg[0]?.sum || 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


const importPayments = async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.payments;
    if (!rows || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: "No valid payment data provided" });

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};
    console.log("[importPayments] rows received:", rows.length);

    // ── Normalised field reader (handles case/space differences) ─────────────
    const normalizeKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9#]/g, "");
    const buildKeyMap  = (r) => new Map(Object.keys(r).map(k => [normalizeKey(k), k]));
    const getVal = (r, km, ...names) => {
      for (const name of names) {
        const actualKey = km.get(normalizeKey(name));
        if (actualKey !== undefined && r[actualKey] !== undefined && r[actualKey] !== "") return r[actualKey];
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

    // ── Safe number parser (strips currency symbols, commas etc.) ─────────────
    const parseAmount = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(String(v).replace(/[^0-9.-]+/g, ""));
      return isNaN(n) ? null : n;
    };

    // Batch-fetch invoices by number for optional invoice linking
    const invoiceNumbers = [...new Set(
      rows.map(r => {
        const km = buildKeyMap(r);
        return String(getVal(r, km, "Invoice #", "invoice", "Invoice")).trim();
      }).filter(Boolean)
    )];
    const invoiceDocs = invoiceNumbers.length
      ? await Invoice.find({ ...tenantFilter, number: { $in: invoiceNumbers } }).select("_id number")
      : [];
    const invoiceMap = new Map(invoiceDocs.map(i => [i.number, i._id]));

    const sanitized = [];
    const skippedRows = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const km = buildKeyMap(r);

      // Amount — required field
      const rawAmt = getVal(r, km, "Amount", "amount");
      const amount = parseAmount(rawAmt);
      if (amount === null) {
        skippedRows.push(`row ${i + 2}: no valid Amount ("${rawAmt}")`);
        continue;
      }

      const invoiceNum  = String(getVal(r, km, "Invoice #", "invoice", "Invoice")).trim();
      const invoiceId   = invoiceMap.get(invoiceNum) || null;
      const rawBillDate = getVal(r, km, "Bill Date", "billDate", "bill_date", "Date", "date");
      const rawDate     = getVal(r, km, "Date", "date", "Payment Date");

      sanitized.push({
        invoice:       invoiceId,
        amount,
        date:          parseDate(rawDate) || new Date(),
        paymentmode:   String(getVal(r, km, "Payment Mode", "paymentmode", "payment_mode") || "Bank Transfer"),
        transactionid: String(getVal(r, km, "Transaction ID", "transactionid", "transaction_id") || ""),
        companyName:   String(getVal(r, km, "Company Name", "companyName", "company_name") || ""),
        voucherNumber: String(getVal(r, km, "Voucher Number", "voucherNumber", "voucher_number") || ""),
        billDate:      parseDate(rawBillDate),
        journal:       String(getVal(r, km, "Journal", "journal") || ""),
        tenant_id:     tenantId,
        created_by:    req.user?._id,
      });
    }

    console.log("[importPayments] sanitized:", sanitized.length, "| skipped:", skippedRows.length);
    if (skippedRows.length) console.log("[importPayments] skipped rows:", skippedRows.join("; "));

    if (sanitized.length === 0)
      return res.status(400).json({ message: `No importable rows. Check that the 'Amount' column has numeric values. Skipped: ${skippedRows.join("; ")}` });

    const result = await Payment.insertMany(sanitized, { ordered: false });
    console.log("[importPayments] inserted:", result.length);
    res.status(201).json({
      message: `Imported ${result.length} payment(s).${skippedRows.length ? ` Skipped ${skippedRows.length} row(s) with invalid data.` : ""}`,
      count: result.length,
      skipped: rows.length - result.length,
    });
  } catch (error) {
    console.error("IMPORT PAYMENTS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = { createPayment, updatePayment, deletePayment, getPaymentsByInvoice, getPaymentsByCustomer, getPayments, importPayments, bulkDeletePayments };
