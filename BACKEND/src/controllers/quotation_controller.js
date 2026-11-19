const mongoose = require("mongoose");
const Quotation = require("../models/Quotation");
const { tenantHasFeature } = require("../utils/tenantFeatures");
const { hasCapability } = require("../middleware/auth");

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tenantFilter = (req) =>
  !req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};

// Each admin/staff sees only THEIR OWN quotations (created_by), on top of the
// tenant boundary. Superadmins and admins or View(Global) holders see everything in tenant.
const ownerFilter = (req) => {
  if (req.user?.is_superadmin || req.user?.admin) return {};
  if (req.permissionLevel === "global") return {};
  const perms = req.user?.permissions instanceof Map ? req.user.permissions.get("Quotations") : (req.user?.permissions?.Quotations || req.user?.role?.permissions?.Quotations);
  if (perms?.["View(Global)"]) return {};
  return req.user?._id ? { created_by: req.user._id } : {};
};

const scopeFilter = (req) => ({ ...tenantFilter(req), ...ownerFilter(req) });

// ─── Quotation approval (tenant add-on "quotation_approval") ───────────────
const approvalEnabled = (req) => tenantHasFeature(req.user?.tenant_id, "quotation_approval");
const isApprover = (req) => hasCapability(req, "Quotations", "Approve");

// Statuses that mean the quotation has gone to the client.
const SENT_STATUSES = ["sent", "pending", "accepted"];

const approvedBy = (req) => ({ status: "approved", decided_by: req.user?._id, decided_at: new Date() });

const historyEntry = (req, action, comment) => ({ action, by: req.user?._id, at: new Date(), comment: comment || undefined });

const staffName = (s) => [s?.firstname, s?.lastname].filter(Boolean).join(" ") || s?.email || "Someone";

const findApproverIds = async (tenantId) => {
  if (!tenantId) return [];
  const Staff = require("../models/Staff");
  const staff = await Staff.find({ tenant_id: tenantId, active: { $ne: false } })
    .select("admin permissions role")
    .populate("role", "permissions")
    .lean();
  const capOf = (perms) => {
    if (!perms) return undefined;
    const quotations = perms instanceof Map ? perms.get("Quotations") : perms.Quotations;
    return quotations?.Approve;
  };
  return staff
    .filter((s) => s.admin || !!(capOf(s.permissions) ?? capOf(s.role?.permissions) ?? false))
    .map((s) => s._id.toString());
};

const notifyStaff = (req, staffIds, payload) => {
  try {
    const io = req.app.get("io");
    if (!io) return;
    [...new Set(staffIds.map(String))].forEach((id) => io.to(id).emit("quotationApproval", payload));
  } catch (err) {
    console.error("[quotation approval] notify failed:", err.message);
  }
};

const getQuotationStats = async (req, res) => {
  try {
    if (req.query.quotation_type && !mongoose.Types.ObjectId.isValid(req.query.quotation_type)) {
      return res.status(400).json({ message: "Invalid quotation type id" });
    }
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const typeFilter = req.query.quotation_type ? { quotation_type: req.query.quotation_type } : {};
    const monthFilter = { ...scopeFilter(req), ...typeFilter, date: { $gte: monthStart, $lt: monthEnd } };

    const toId = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : v);
    const aggFilter = { ...monthFilter };
    if (aggFilter.tenant_id) aggFilter.tenant_id = toId(aggFilter.tenant_id);
    if (aggFilter.quotation_type) aggFilter.quotation_type = toId(aggFilter.quotation_type);
    if (aggFilter.created_by) aggFilter.created_by = toId(aggFilter.created_by);

    const [totalThisMonth, acceptedThisMonth, valueAgg] = await Promise.all([
      Quotation.countDocuments(monthFilter),
      Quotation.countDocuments({ ...monthFilter, status: "accepted" }),
      Quotation.aggregate([
        { $match: aggFilter },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]),
    ]);

    res.json({
      totalThisMonth,
      acceptedThisMonth,
      totalValue: valueAgg[0]?.total || 0,
    });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    res.status(500).json({ message: error.message });
  }
};

const getQuotations = async (req, res) => {
  try {
    if (req.query.quotation_type && !mongoose.Types.ObjectId.isValid(req.query.quotation_type)) {
      return res.status(400).json({ message: "Invalid quotation type id" });
    }
    const filter = { ...scopeFilter(req) };
    if (req.query.quotation_type) filter.quotation_type = req.query.quotation_type;

    const { page, search } = req.query;
    const isPaginated = page !== undefined || search !== undefined;

    if (!isPaginated) {
      const limit = parseInt(req.query.limit) || 0;

      let query = Quotation.find(filter)
        .populate("client", "company")
        .populate("quotation_type", "name slug icon")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 });
      if (limit) query = query.limit(limit);

      const quotations = await query;
      return res.json(quotations);
    }

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      filter.$or = [{ number: re }];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);

    const [total, quotations] = await Promise.all([
      Quotation.countDocuments(filter),
      Quotation.find(filter)
        .populate("client", "company")
        .populate("quotation_type", "name slug icon")
        .populate({ path: "bank_detail", populate: { path: "branch" } })
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: quotations,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    res.status(500).json({ message: error.message });
  }
};

const createQuotation = async (req, res) => {
  try {
    const {
      client, date, valid_till, status, items, subtotal, total, total_tax, notes, adminnote,
      quotation_type, format, gst_percent, branding, project_details, rooms, theme, attachments,
      discount_percent, discount_total, currency, bank_detail, show_item_images,
      contact_number, client_address,
    } = req.body;
    if (!client && status !== "draft") return res.status(400).json({ message: "client is required" });

    // Validate foreign references belong to current tenant
    if (client && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(client)) return res.status(400).json({ message: "Invalid client id" });
      const Client = require("../models/Client");
      const c = await Client.findOne({ _id: client, tenant_id: req.user.tenant_id });
      if (!c) return res.status(400).json({ message: "Client not found in your account" });
    }
    if (quotation_type && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(quotation_type)) return res.status(400).json({ message: "Invalid quotation type id" });
      const QuotationType = require("../models/QuotationType");
      const qt = await QuotationType.findOne({ _id: quotation_type, tenant_id: req.user.tenant_id });
      if (!qt) return res.status(400).json({ message: "Quotation type not found in your account" });
    }
    if (bank_detail && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(bank_detail)) return res.status(400).json({ message: "Invalid bank detail id" });
      const BankDetail = require("../models/BankDetail");
      const bd = await BankDetail.findOne({ _id: bank_detail, tenant_id: req.user.tenant_id });
      if (!bd) return res.status(400).json({ message: "Bank detail not found in your account" });
    }



    let finalStatus = status || "draft";
    let approval;
    let approval_history;
    if (await approvalEnabled(req)) {
      if (await isApprover(req)) {
        approval = approvedBy(req);
        approval_history = [historyEntry(req, "auto_approved")];
      } else {
        approval = { status: "none" };
        if (SENT_STATUSES.includes(finalStatus)) finalStatus = "draft";
      }
    }

    const docData = {
      client,
      tenant_id: req.user?.tenant_id,
      date: date || undefined,
      valid_till: valid_till || undefined,
      status: finalStatus,
      approval,
      approval_history,
      items: items || [],
      subtotal: Number(subtotal) || 0,
      total_tax: Number(total_tax) || 0,
      total: Number(total) || 0,
      discount_percent: Number(discount_percent) || 0,
      discount_total: Number(discount_total) || 0,
      currency,
      notes,
      adminnote,
      quotation_type: quotation_type || undefined,
      format: format || "simple",
      gst_percent: gst_percent ?? 18,
      branding,
      project_details,
      rooms: rooms || [],
      theme,
      attachments,
      show_item_images: show_item_images !== false,
      bank_detail: bank_detail || undefined,
      contact_number,
      client_address,
      created_by: req.user?._id,
    };

    let quotation;
    let lastError;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        let rand = Math.floor(100000 + Math.random() * 900000);
        if (attempt > 0) rand = Math.floor(100000 + ((rand + attempt * 73937) % 900000));
        const number = `QUO-${rand}`;
        quotation = await Quotation.create({
          ...docData,
          number,
        });
        break;
      } catch (err) {
        if (err.code === 11000) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    if (!quotation) throw lastError;

    res.status(201).json(quotation);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    res.status(400).json({ message: error.message });
  }
};

const getQuotationById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    const filter = { _id: req.params.id, ...scopeFilter(req) };
    const quotation = await Quotation.findOne(filter)
      .populate("client", "company name address city state zip country phonenumber")
      .populate("quotation_type", "name slug icon format theme")
      .populate({ path: "bank_detail", populate: { path: "branch" } });
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    res.json(quotation);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation id" });
    res.status(500).json({ message: error.message });
  }
};

const updateQuotation = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    const filter = { _id: req.params.id, ...tenantFilter(req) };
    const payload = { ...req.body };
    const unsets = {};
    Object.keys(payload).forEach((key) => {
      if (payload[key] === "") {
        delete payload[key];
        unsets[key] = 1;
      }
    });

    delete payload.tenant_id;
    delete payload._id;
    delete payload.created_by;
    delete payload.number;
    delete payload.createdAt;
    delete payload.approval;
    delete payload.approval_history;

    // Check cross-tenant references if passed
    if (payload.client && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(payload.client)) return res.status(400).json({ message: "Invalid client id" });
      const Client = require("../models/Client");
      const c = await Client.findOne({ _id: payload.client, tenant_id: req.user.tenant_id });
      if (!c) return res.status(400).json({ message: "Client not found in your account" });
    }
    if (payload.quotation_type && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(payload.quotation_type)) return res.status(400).json({ message: "Invalid quotation type id" });
      const QuotationType = require("../models/QuotationType");
      const qt = await QuotationType.findOne({ _id: payload.quotation_type, tenant_id: req.user.tenant_id });
      if (!qt) return res.status(400).json({ message: "Quotation type not found in your account" });
    }
    if (payload.bank_detail && req.user?.tenant_id) {
      if (!mongoose.Types.ObjectId.isValid(payload.bank_detail)) return res.status(400).json({ message: "Invalid bank detail id" });
      const BankDetail = require("../models/BankDetail");
      const bd = await BankDetail.findOne({ _id: payload.bank_detail, tenant_id: req.user.tenant_id });
      if (!bd) return res.status(400).json({ message: "Bank detail not found in your account" });
    }

    let historyPush;

    if (await approvalEnabled(req)) {
      const existing = await Quotation.findOne(filter).lean();
      if (!existing) return res.status(404).json({ message: "Quotation not found" });
      const current = existing.approval?.status;
      if (current) {
        let next = current;
        const contentKeys = ["items", "rooms", "subtotal", "total", "total_tax", "contact_number", "client_address", "client", "discount_percent", "discount_total", "bank_detail", "quotation_type"];
        const isContentModified = contentKeys.some((k) => payload[k] !== undefined && JSON.stringify(payload[k]) !== JSON.stringify(existing[k]));

        if (!isContentModified && current === "approved" && payload.status === "sent") {
          // Keep approval status as approved
        } else if (!(await isApprover(req)) && (current === "approved" || current === "rejected")) {
          next = "none";
          payload.approval = { status: "none" };
          historyPush = historyEntry(req, "reset", current === "approved" ? "Edited after approval" : "Edited after rejection");
        }
        if (next !== "approved" && SENT_STATUSES.includes(payload.status)) payload.status = "draft";
      }
    }

    const update = { $set: payload };
    if (Object.keys(unsets).length > 0) update.$unset = unsets;
    if (historyPush) update.$push = { approval_history: historyPush };

    const quotation = await Quotation.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    res.json(quotation);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    res.status(400).json({ message: error.message });
  }
};

const deleteQuotation = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    const filter = { _id: req.params.id, ...tenantFilter(req) };
    const quotation = await Quotation.findOneAndDelete(filter);
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    res.json({ message: "Quotation removed" });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation id" });
    res.status(500).json({ message: error.message });
  }
};

const checkApprovalAccess = async (req, res, { approverOnly = false } = {}) => {
  if (!(await approvalEnabled(req))) {
    res.status(403).json({ code: "FEATURE_DISABLED", message: "Quotation approval is not enabled for your account" });
    return false;
  }
  if (approverOnly && !(await isApprover(req))) {
    res.status(403).json({ message: "You don't have permission to approve quotations" });
    return false;
  }
  return true;
};

const requestApproval = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    if (!(await checkApprovalAccess(req, res))) return;
    const quotation = await Quotation.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    const current = quotation.approval?.status;
    if (current === "pending") return res.status(400).json({ message: "Approval already requested" });
    if (current === "approved") return res.status(400).json({ message: "Quotation is already approved" });
    if (!quotation.client) return res.status(400).json({ message: "Select a customer before requesting approval" });

    quotation.approval = { status: "pending", requested_by: req.user?._id, requested_at: new Date() };
    quotation.approval_history.push(historyEntry(req, "requested"));
    await quotation.save();

    const approverIds = (await findApproverIds(quotation.tenant_id)).filter((id) => id !== String(req.user?._id));
    notifyStaff(req, approverIds, {
      event: "requested",
      quotationId: quotation._id.toString(),
      number: quotation.number,
      by: staffName(req.user),
    });

    res.json(quotation);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation id" });
    res.status(400).json({ message: error.message });
  }
};

const decideApproval = (decision) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    if (!(await checkApprovalAccess(req, res, { approverOnly: true }))) return;
    const quotation = await Quotation.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    const current = quotation.approval?.status;
    if (decision === "rejected" && current !== "pending") {
      return res.status(400).json({ message: "Only quotations awaiting approval can be rejected" });
    }
    if (decision === "approved" && current === "approved") {
      return res.status(400).json({ message: "Quotation is already approved" });
    }
    const comment = String(req.body?.comment || "").trim();
    if (decision === "rejected" && !comment) {
      return res.status(400).json({ message: "Please give a reason for rejecting" });
    }

    quotation.set("approval.status", decision);
    quotation.set("approval.decided_by", req.user?._id);
    quotation.set("approval.decided_at", new Date());
    quotation.set("approval.comment", comment || undefined);
    quotation.approval_history.push(historyEntry(req, decision, comment));
    await quotation.save();

    const makerId = quotation.approval?.requested_by?.toString();
    if (makerId && makerId !== String(req.user?._id)) {
      notifyStaff(req, [makerId], {
        event: decision,
        quotationId: quotation._id.toString(),
        number: quotation.number,
        by: staffName(req.user),
        comment: comment || undefined,
      });
    }

    res.json(quotation);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation id" });
    res.status(400).json({ message: error.message });
  }
};

const approveQuotation = decideApproval("approved");
const rejectQuotation = decideApproval("rejected");

const getPendingApprovals = async (req, res) => {
  try {
    if (!(await checkApprovalAccess(req, res, { approverOnly: true }))) return;
    const quotations = await Quotation.find({ ...tenantFilter(req), "approval.status": "pending" })
      .populate("client", "company")
      .populate("quotation_type", "name slug icon")
      .populate("approval.requested_by", "firstname lastname email")
      .sort({ "approval.requested_at": 1 });
    res.json(quotations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getApprovalHistory = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    const quotation = await Quotation.findOne({ _id: req.params.id, ...tenantFilter(req) })
      .select("number approval approval_history")
      .populate("approval_history.by", "firstname lastname email")
      .lean();
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    res.json({
      number: quotation.number,
      status: quotation.approval?.status || null,
      history: quotation.approval_history || [],
    });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation id" });
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getQuotationStats, getQuotations, createQuotation, getQuotationById, updateQuotation, deleteQuotation,
  requestApproval, approveQuotation, rejectQuotation, getPendingApprovals, getApprovalHistory,
};
