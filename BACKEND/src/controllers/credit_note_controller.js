const CreditNote = require("../models/CreditNote");
const InvoiceService = require("../services/InvoiceService");
const Client = require("../models/Client");
const { logActivity } = require("../services/ActivityLogService");
const docSettings = require("../services/docSettings");

// Credit notes of the user's own company only.
const cnScope = (req) => {
  const scope = {};
  if (!req.user?.is_superadmin && req.user?.tenant_id) scope.tenant_id = req.user.tenant_id;
  return scope;
};
const duplicateNumberError = (res, number) =>
  res.status(400).json({ message: `Credit note number "${number}" is already used by another credit note.` });

const getCreditNotes = async (req, res) => {
  try {
    const baseFilter = {};
    if (req.query.client) baseFilter.client = req.query.client;
    if (!req.user?.is_superadmin && req.user?.tenant_id) baseFilter.tenant_id = req.user.tenant_id;

    const { page, limit, search } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard aggregation, exports, the invoice-tab credit note list)
    // keep getting the full bare array exactly as before.
    if (!isPaginated) {
      const creditNotes = await CreditNote.find(baseFilter).populate("client", "company").sort({ createdAt: -1 });
      return res.json(creditNotes);
    }

    const filter = { ...baseFilter };
    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchTerm = String(search).trim();
      const re = new RegExp(escapeRegExp(searchTerm), "i");
      const matchingClients = await Client.find({ company: re }).select("_id");
      // Status is shown in the table via statusMap's numeric-code -> label
      // (Open/Closed/Void), not the raw stored number — resolve which
      // code(s)' label text matches, mirroring statusMap in CreditNotes.tsx.
      const STATUS_LABELS = { 1: "Open", 2: "Closed", 3: "Void" };
      const searchLower = searchTerm.toLowerCase();
      const matchingStatusCodes = Object.entries(STATUS_LABELS)
        .filter(([, label]) => label.toLowerCase().includes(searchLower))
        .map(([code]) => Number(code));
      filter.$or = [
        { number: re },
        { reference: re },
        { client: { $in: matchingClients.map((c) => c._id) } },
        { status: { $in: matchingStatusCodes } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    // "Credits Available" always reflects the whole tenant, independent of
    // the currently active search — matches prior behavior (summed from the
    // full, unfiltered credit note list).
    const [total, creditsAvailableAgg, creditNotes] = await Promise.all([
      CreditNote.countDocuments(filter),
      CreditNote.aggregate([
        { $match: { ...baseFilter, status: 1 } },
        { $group: { _id: null, sum: { $sum: { $ifNull: ["$remaining_amount", "$total"] } } } },
      ]),
      CreditNote.find(filter)
        .populate("client", "company")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: creditNotes,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      creditsAvailable: creditsAvailableAgg[0]?.sum || 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


const getCreditNotesByInvoice = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const filter = { "invoices_credited.invoice": invoiceId };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const creditNotes = await CreditNote.find(filter).populate("client", "company");

    const result = creditNotes.map((cn) => {
      const cnObj = cn.toObject();
      const appliedToThisInvoice = (cn.invoices_credited || [])
        .filter((c) => String(c.invoice) === String(invoiceId))
        .reduce((sum, c) => sum + (c.amount || 0), 0);
      cnObj.applied_amount = appliedToThisInvoice;
      return cnObj;
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCreditNoteById = async (req, res) => {
  try {
    const creditNote = await CreditNote.findOne({ _id: req.params.id, ...cnScope(req) }).populate("client", "company contact_person email phonenumber address city state zip country billing_street billing_city billing_state billing_zip billing_country shipping_street shipping_city shipping_state shipping_zip shipping_country gst_number pan_number vat currency");
    if (!creditNote) return res.status(404).json({ message: "Credit Note not found" });

    // Fetch available invoices for this client that are not fully paid
    const Invoice = require("../models/Invoice");
    const Payment = require("../models/Payment");

    // Build invoice filter — always scope to the credit note's tenant to prevent cross-tenant leakage
    const invoiceFilter = {
      client: creditNote.client._id,
      status: { $in: ["unpaid", "partially_paid", "sent", "recorded"] }
    };
    if (creditNote.tenant_id) invoiceFilter.tenant_id = creditNote.tenant_id;

    const clientInvoices = await Invoice.find(invoiceFilter);

    const available_invoices = [];
    for (const inv of clientInvoices) {
      const payments = await Payment.find({ invoice: inv._id });
      const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
      const balanceDue = Math.max(inv.total - totalPaid, 0);

      if (balanceDue > 0) {
        available_invoices.push({
          _id: inv._id,
          number: inv.number,
          date: inv.date,
          total: inv.total,
          amount_paid: totalPaid,
          balance_due: balanceDue
        });
      }
    }

    const cnObj = creditNote.toObject();
    cnObj.available_invoices = available_invoices;
    await docSettings.addDisplayNames(cnObj);

    res.json(cnObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


const applyCreditNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId, amount } = req.body;

    if (!invoiceId || !amount || !(Number(amount) > 0)) {
      return res.status(400).json({ message: "Invoice ID and a positive amount are required" });
    }
    const { isValidObjectId } = require("mongoose");
    if (!isValidObjectId(id) || !isValidObjectId(invoiceId)) return res.status(400).json({ message: "Invalid id" });

    const creditNote = await CreditNote.findOne({ _id: id, ...cnScope(req) });
    if (!creditNote) return res.status(404).json({ message: "Credit Note not found" });

    if (creditNote.status === 3) {
      return res.status(400).json({ message: "Cannot apply a voided Credit Note" });
    }

    const remainingCredits = creditNote.remaining_amount;
    if (Number(amount) > remainingCredits) {
      return res.status(400).json({ message: `Insufficient credits. Available: ${remainingCredits}` });
    }

    const Invoice = require("../models/Invoice");
    const Payment = require("../models/Payment");

    // The invoice must belong to the credit note's company.
    const invoice = await Invoice.findOne({ _id: invoiceId, tenant_id: creditNote.tenant_id ?? null });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (creditNote.client && String(creditNote.client) !== String(invoice.client)) {
      return res.status(400).json({ message: "This credit note belongs to a different customer than the invoice." });
    }
    if (invoice.status === "cancelled") {
      return res.status(400).json({ message: "Cannot apply credit to a cancelled invoice." });
    }

    // Calculate balance due on invoice
    const payments = await Payment.find({ invoice: invoiceId });
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balanceDue = Math.max(invoice.total - totalPaid, 0);

    if (Number(amount) > balanceDue) {
      return res.status(400).json({ message: `Applied amount exceeds invoice balance due of ${balanceDue}` });
    }

    // Apply credit to credit note
    creditNote.invoices_credited.push({
      invoice: invoiceId,
      invoice_number: invoice.number,
      amount: Number(amount),
      date: new Date()
    });

    // Check if credit note is now fully used
    const totalApplied = creditNote.invoices_credited.reduce((sum, inv) => sum + (inv.amount || 0), 0);
    if (totalApplied >= creditNote.total) {
      creditNote.status = 2; // Closed
    }

    await creditNote.save();

    // Create payment entry for invoice
    const payment = await Payment.create({
      invoice: invoiceId,
      amount: Number(amount),
      paymentmode: "Credit Note",
      paymentmethod: `Applied Credit Note ${creditNote.number}`,
      credit_note: creditNote._id,
      date: new Date(),
      transactionid: `CN-APP-${creditNote.number}-${Date.now().toString().slice(-4)}`,
      note: `Applied credit note ${creditNote.number} to invoice ${invoice.number}`,
      tenant_id: req.user?.tenant_id,
      created_by: req.user?._id
    });

    // Update invoice status
    const InvoiceService = require("../services/InvoiceService");
    await InvoiceService.updateStatus(invoiceId);

    logActivity(req, `Applied ${amount} from Credit Note ${creditNote.number} to Invoice ${invoice.number}`, {
      rel_id: creditNote._id,
      rel_type: "credit_note"
    });

    res.status(200).json({
      message: "Credit applied successfully",
      creditNote,
      payment
    });
  } catch (error) {
    console.error("Apply Credit Note Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const createCreditNote = async (req, res) => {
  try {
    const payload = { ...req.body };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });

    const client = payload.client || payload.rel_id;
    let status = payload.status;
    if (status === "open") status = 1;
    if (status === "closed") status = 2;
    if (status === "void") status = 3;
    if (status !== undefined) status = Number(status);

    const autoNumber = !!payload.auto_number || !String(payload.number || "").trim();
    ["auto_number", "_id", "tenant_id", "createdAt", "updatedAt", "invoices_credited"].forEach((k) => delete payload[k]);
    const tenantId = req.user?.tenant_id;
    // The customer must be one of this company's customers.
    if (!client || !require("mongoose").isValidObjectId(client) || !(await Client.exists({ _id: client, tenant_id: tenantId ?? null }))) {
      return res.status(400).json({ message: "Please select a valid customer." });
    }
    const totals = InvoiceService.calculateTotals(payload);
    const doc = { ...payload, client, status, ...totals, tenant_id: tenantId, created_by: req.user?._id };
    let creditNote;
    try {
      // Setup > Settings > Credit Notes: Prefix + Next Number + Number Format.
      creditNote = autoNumber
        ? await docSettings.createWithNextNumber("credit_note", tenantId, payload.date, (number) => CreditNote.create({ ...doc, number }))
        : await CreditNote.create(doc);
    } catch (err) {
      if (err?.code === 11000) return duplicateNumberError(res, payload.number);
      throw err;
    }
    logActivity(req, `Created credit note: ${creditNote.number || creditNote._id}`, { rel_id: creditNote._id, rel_type: "credit_note" });
    res.status(201).json(creditNote);
  } catch (error) {
    console.error("Create Credit Note Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const updateCreditNote = async (req, res) => {
  try {
    const payload = { ...req.body };
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });

    const client = payload.client || payload.rel_id;
    let status = payload.status;
    if (status === "open") status = 1;
    if (status === "closed") status = 2;
    if (status === "void") status = 3;
    if (status !== undefined) status = Number(status);

    ["auto_number", "tenant_id", "created_by", "invoices_credited", "_id"].forEach((k) => delete payload[k]);
    if (client && (!require("mongoose").isValidObjectId(client) || !(await Client.exists({ _id: client, ...cnScope(req) })))) {
      return res.status(400).json({ message: "Please select a valid customer." });
    }
    const totals = InvoiceService.calculateTotals(payload);
    let creditNote;
    try {
      creditNote = await CreditNote.findOneAndUpdate(
        { _id: req.params.id, ...cnScope(req) },
        { ...payload, client, status, ...totals },
        { new: true }
      );
    } catch (err) {
      if (err?.code === 11000) return duplicateNumberError(res, payload.number);
      throw err;
    }
    if (!creditNote) return res.status(404).json({ message: "Credit Note not found" });
    logActivity(req, `Updated credit note: ${creditNote.number || creditNote._id}`, { rel_id: creditNote._id, rel_type: "credit_note" });
    res.json(creditNote);
  } catch (error) {
    console.error("Update Credit Note Error:", error);
    res.status(500).json({ message: error.message });
  }
};

const deleteCreditNote = async (req, res) => {
  try {
    const creditNote = await CreditNote.findOneAndDelete({ _id: req.params.id, ...cnScope(req) });
    if (!creditNote) return res.status(404).json({ message: "Credit Note not found" });
    await docSettings.releaseNumberOnDelete("credit_note", creditNote.tenant_id, creditNote);
    logActivity(req, `Deleted credit note: ${creditNote.number || creditNote._id}`, { rel_type: "credit_note" });
    res.json({ message: "Credit Note deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const importCreditNotes = async (req, res) => {
  try {
    const rowsRaw = Array.isArray(req.body) ? req.body : req.body.creditNotes;
    if (!rowsRaw || !Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      return res.status(400).json({ message: "No valid credit note data provided" });
    }

    const tenantId = req.user?.tenant_id;
    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};
    console.log("[importCreditNotes] user tenant_id:", tenantId, "| rows to import:", rowsRaw.length);

    // Batch-fetch all clients referenced by company name
    // "Customer" = exported column, "company"/"Company" = custom import column
    const companyNames = [...new Set(
      rowsRaw.map(r => r.Customer || r.company || r.Company).filter(Boolean)
    )];
    const clientDocs = companyNames.length
      ? await Client.find({ company: { $in: companyNames.map(c => new RegExp(`^${c}$`, 'i')) }, ...tenantFilter }).select("_id company")
      : [];
    const clientMap = new Map(clientDocs.map(c => [c.company.toLowerCase().trim(), c._id]));

    const baseTs = Date.now();

    const normalizeCNStatus = (s) => {
      if (!s) return 1;
      if (typeof s === "number") return s;
      const sl = String(s).toLowerCase().trim();
      if (sl === "closed") return 2;
      if (sl === "void") return 3;
      if (sl === "open") return 1;
      const n = Number(s);
      return isNaN(n) ? 1 : n;
    };

    // Map CSV columns to model fields
    // "Credit Note #" = exported column, "number"/"Number" = custom import column
    // "Amount" = exported column, "total" = custom import column
    const rows = rowsRaw.map((r, i) => {
      const companyName = String(r.Customer || r.company || r.Company || "").toLowerCase().trim();
      const clientId = clientMap.get(companyName);
      if (!clientId) return null; // no client available — skip row
      
      const rawAmount = String(r.Amount || r.total || r.Total || "0");
      const total = Number(rawAmount.replace(/[^0-9.-]+/g,"")) || 0;
      
      const number = r["Credit Note #"] || r.number || r.Number || `CN-${baseTs}${i}`;
      return {
        client:     clientId,
        total,
        subtotal:   total,
        number,
        date:       r.date || r.Date ? new Date(r.date || r.Date) : new Date(),
        status:     normalizeCNStatus(r.Status || r.status),
        reference:  r.Reference || r.reference || "",
        tenant_id:  tenantId,
        created_by: req.user?._id,
        items:      [{ description: "Imported Credit Note", rate: total, qty: 1 }],
      };
    }).filter(Boolean);

    if (rows.length === 0) {
      return res.status(400).json({ message: "No importable rows. Make sure your file has valid data and at least one client exists in the system." });
    }

    // Deduplicate by number within tenant
    const incomingNumbers = rows.map(r => r.number).filter(Boolean);
    const existing = await CreditNote.find({
      ...tenantFilter,
      number: { $in: incomingNumbers },
    }).select("number");
    const existingSet = new Set(existing.map(cn => cn.number));

    const newCreditNotes = rows.filter(r => !existingSet.has(r.number));
    const skipped = rows.length - newCreditNotes.length;
    console.log("[importCreditNotes] new:", newCreditNotes.length, "| skipped (duplicates):", skipped);

    if (newCreditNotes.length === 0) {
      return res.status(200).json({
        message: `All ${rows.length} credit note(s) already exist — nothing imported.`,
        count: 0,
        skipped,
      });
    }

    const result = await CreditNote.insertMany(newCreditNotes, { ordered: false });
    console.log("[importCreditNotes] inserted:", result.length);
    res.status(201).json({
      message: `Imported ${result.length} new credit note(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}.`,
      count: result.length,
      skipped,
    });
  } catch (error) {
    console.error("IMPORT CREDIT NOTES ERROR:", error);
    if (error.code === 11000) {
      return res.status(207).json({ message: "Partial import completed, some duplicates skipped." });
    }
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getCreditNotes,
  getCreditNotesByInvoice,
  getCreditNoteById,
  createCreditNote,
  updateCreditNote,
  deleteCreditNote,
  importCreditNotes,
  applyCreditNote,
};
