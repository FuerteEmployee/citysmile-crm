const Vendor = require("../models/Vendor");
const Purchase = require("../models/Purchase");
const { logActivity } = require("../services/ActivityLogService");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");
const {
  checkEmail, checkContactPhone, checkPan, checkGstin, checkLength, firstError, isBlank,
} = require("../hrms/utils/fieldRules");

const escapeRegExp = (string) => String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Editable vendor fields, their labels and max lengths. Anything else in a
// request body (tenant_id, _id, created_by, createdAt, unknown keys) is dropped.
const FIELDS = {
  company_name: { label: "Company Name", max: 200 },
  vendor_reference: { label: "Vendor Reference", max: 100 },
  connect_person: { label: "Connect Person", max: 150 },
  phone_number: { label: "Phone Number", max: 30 },
  address: { label: "Address", max: 1000 },
  email: { label: "Email", max: 254 },
  pan_number: { label: "PAN Number", max: 10 },
  gst_number: { label: "GST Number", max: 15 },
  account_details: { label: "Account Details", max: 1000 },
  sales_person: { label: "Sales Person", max: 150 },
  branch: { label: "Branch", max: 150 },
};

// HTML tags in plain-text fields are never legitimate here and become stored
// XSS wherever the value is later rendered as HTML (exports, templates).
const HTML_TAG = /<\s*\/?\s*[a-z!?][^>]*>/i;

const tenantScope = (req, query = {}) => {
  if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;
  return query;
};

/**
 * Cleans and validates a vendor body.
 * @param {object} body       raw request body / import row
 * @param {object} [existing] current vendor (update) — fields not sent are kept
 * @returns {{ data?: object, error?: string }}
 */
const cleanVendorInput = (body, existing = null) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid vendor data" };
  const src = withoutProtected(body);
  const data = {};
  for (const [key, { label }] of Object.entries(FIELDS)) {
    if (!(key in src)) continue;
    let v = src[key];
    if (v === null || v === undefined) v = "";
    if (typeof v !== "string" && typeof v !== "number") return { error: `${label} must be text` };
    v = String(v).trim();
    if (key === "email") v = v.toLowerCase();
    if (key === "pan_number" || key === "gst_number") v = v.toUpperCase();
    data[key] = v;
  }

  if (!existing || "company_name" in data) {
    if (isBlank(data.company_name)) return { error: "Company Name is required" };
  }

  const pan = "pan_number" in data ? data.pan_number : existing?.pan_number || "";
  const gst = "gst_number" in data ? data.gst_number : existing?.gst_number || "";
  const gstOrPanChanged = "pan_number" in data || "gst_number" in data;

  const error = firstError(
    ...Object.entries(FIELDS).map(([k, { label, max }]) => (k in data ? checkLength(label, data[k], max) : null)),
    ...Object.entries(FIELDS).map(([k, { label }]) =>
      (k in data && HTML_TAG.test(data[k]) ? `${label} must not contain HTML tags` : null)),
    "phone_number" in data ? checkContactPhone("Phone Number", data.phone_number) : null,
    "email" in data ? checkEmail("Email", data.email) : null,
    "pan_number" in data ? checkPan("PAN Number", data.pan_number) : null,
    gstOrPanChanged ? checkGstin("GST Number", gst, pan) : null,
  );
  if (error) return { error };
  return { data };
};

// Branch is free text unless the company has HRMS branches set up; then only
// one of that company's branch names is accepted (case-insensitive).
let HRMSBranch;
const loadCompanyBranches = async (tenantId) => {
  if (!tenantId) return [];
  HRMSBranch = HRMSBranch || require("../hrms/models/hrms_branch_model");
  const rows = await HRMSBranch.find({ tenant_id: tenantId }).select("name").lean();
  return rows.map((b) => String(b.name || "").trim()).filter(Boolean);
};
const resolveBranch = (branch, companyBranches) => {
  if (isBlank(branch) || companyBranches.length === 0) return { branch };
  const match = companyBranches.find((b) => b.toLowerCase() === branch.toLowerCase());
  return match ? { branch: match } : { error: `Branch "${branch}" does not exist in your company` };
};

const findDuplicateName = (tenantId, companyName, excludeId) => {
  const query = { tenant_id: tenantId, company_name: new RegExp(`^${escapeRegExp(companyName)}$`, "i") };
  if (excludeId) query._id = { $ne: excludeId };
  return Vendor.findOne(query).select("_id company_name").lean();
};

// Same company name being created right now (double-click / two tabs): the
// second request gets a 409 instead of creating a duplicate. Per-process only —
// see the report: a DB-level unique index is the multi-server answer.
const creatingNow = new Set();

const getVendors = async (req, res) => {
  try {
    const filter = tenantScope(req);

    const { page, limit, search, branch } = req.query;
    if (branch) filter.branch = String(branch);
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior: callers that don't ask for pagination (the vendor
    // picker on purchase bills, exports) keep getting the full bare array.
    if (!isPaginated) {
      const vendors = await Vendor.find(filter).sort({ createdAt: -1 });
      return res.json(vendors);
    }

    if (search && String(search).trim()) {
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      filter.$or = [
        { company_name: re },
        { vendor_reference: re },
        { connect_person: re },
        { phone_number: re },
        { email: re },
        { gst_number: re },
        { pan_number: re },
        { sales_person: re },
        { branch: re },
        { address: re },
        { account_details: re },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, vendors] = await Promise.all([
      Vendor.countDocuments(filter),
      Vendor.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: vendors,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
    });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const getVendorById = async (req, res) => {
  try {
    const vendor = await Vendor.findOne(tenantScope(req, { _id: req.params.id }));
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    res.json(vendor);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const createVendor = async (req, res) => {
  let lockKey = null;
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(400).json({ message: "Your account is not linked to a company" });

    const { data, error } = cleanVendorInput(req.body);
    if (error) return res.status(400).json({ message: error });

    if (data.branch) {
      const b = resolveBranch(data.branch, await loadCompanyBranches(tenantId));
      if (b.error) return res.status(400).json({ message: b.error });
      data.branch = b.branch;
    }

    lockKey = `${tenantId}|${data.company_name.toLowerCase()}`;
    if (creatingNow.has(lockKey)) {
      lockKey = null;
      return res.status(409).json({ message: `Vendor "${data.company_name}" is already being created` });
    }
    creatingNow.add(lockKey);

    const dup = await findDuplicateName(tenantId, data.company_name);
    if (dup) return res.status(409).json({ message: `A vendor named "${dup.company_name}" already exists` });

    const vendor = await Vendor.create({ ...data, created_by: req.user?._id, tenant_id: tenantId });
    logActivity(req, `Created vendor: ${vendor.company_name}`, { rel_id: vendor._id, rel_type: "vendor" });
    res.status(201).json(vendor);
  } catch (error) {
    console.error("Vendor Creation Error:", error);
    res.status(statusForError(error)).json({ message: error.message });
  } finally {
    if (lockKey) creatingNow.delete(lockKey);
  }
};

const updateVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findOne(tenantScope(req, { _id: req.params.id }));
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const { data, error } = cleanVendorInput(req.body, vendor);
    if (error) return res.status(400).json({ message: error });

    if ("branch" in data && data.branch && data.branch !== vendor.branch) {
      const b = resolveBranch(data.branch, await loadCompanyBranches(vendor.tenant_id));
      if (b.error) return res.status(400).json({ message: b.error });
      data.branch = b.branch;
    }

    if ("company_name" in data && data.company_name.toLowerCase() !== String(vendor.company_name).toLowerCase()) {
      const dup = await findDuplicateName(vendor.tenant_id, data.company_name, vendor._id);
      if (dup) return res.status(409).json({ message: `A vendor named "${dup.company_name}" already exists` });
    }

    vendor.set(data);
    const updated = await vendor.save();
    logActivity(req, `Updated vendor: ${updated.company_name}`, { rel_id: updated._id, rel_type: "vendor" });
    res.json(updated);
  } catch (error) {
    console.error("Vendor Update Error:", error);
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const countBills = (vendorIds, req) =>
  Purchase.aggregate([
    { $match: tenantScope(req, { vendor_id: { $in: vendorIds } }) },
    { $group: { _id: "$vendor_id", bills: { $sum: 1 } } },
  ]);

const deleteVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findOne(tenantScope(req, { _id: req.params.id }));
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const [billInfo] = await countBills([vendor._id], req);
    if (billInfo?.bills) {
      return res.status(409).json({
        message: `Cannot delete "${vendor.company_name}": it has ${billInfo.bills} purchase bill(s)`,
        bills: billInfo.bills,
      });
    }

    await vendor.deleteOne();
    logActivity(req, `Deleted vendor: ${vendor.company_name}`, { rel_id: vendor._id, rel_type: "vendor" });
    res.json({ message: "Vendor removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const getVendorPurchases = async (req, res) => {
  try {
    const vendor = await Vendor.findOne(tenantScope(req, { _id: req.params.id }));
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const purchases = await Purchase.find(tenantScope(req, { vendor_id: vendor._id })).sort({ bill_date: -1 });

    const totals = purchases.reduce(
      (acc, p) => {
        acc.count += 1;
        acc.taxable += p.amount || 0;
        acc.gst += (p.cgst || 0) + (p.sgst || 0) + (p.igst || 0);
        acc.total += p.total || 0;
        if (p.payment_status !== "Paid") acc.outstanding += p.total || 0;
        return acc;
      },
      { count: 0, taxable: 0, gst: 0, total: 0, outstanding: 0 }
    );

    res.json({ purchases, totals });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const importVendors = async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    if (rows.length === 0) {
      return res.status(400).json({ message: "No vendor rows received", count: 0 });
    }

    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(400).json({ message: "Your account is not linked to a company", count: 0 });

    const [existing, companyBranches] = await Promise.all([
      Vendor.find({ tenant_id: tenantId }).select("company_name").lean(),
      loadCompanyBranches(tenantId),
    ]);
    const seen = new Set(existing.map((v) => String(v.company_name).trim().toLowerCase()));

    const docs = [];
    const errors = [];
    let duplicates = 0;

    rows.forEach((row, i) => {
      const { data, error } = cleanVendorInput(row);
      if (error) {
        errors.push(`Row ${i + 1}: ${error}`);
        return;
      }
      if (data.branch) {
        const b = resolveBranch(data.branch, companyBranches);
        if (b.error) {
          errors.push(`Row ${i + 1}: ${b.error}`);
          return;
        }
        data.branch = b.branch;
      }
      const key = data.company_name.toLowerCase();
      if (seen.has(key)) {
        duplicates += 1;
        errors.push(`Row ${i + 1}: "${data.company_name}" already exists`);
        return;
      }
      seen.add(key);
      docs.push({ ...data, created_by: req.user?._id, tenant_id: tenantId });
    });

    let created = [];
    if (docs.length > 0) {
      created = await Vendor.insertMany(docs);
      logActivity(req, `Imported ${created.length} vendors`, { rel_type: "vendor" });
    }

    res.status(201).json({
      count: created.length,
      created: created.length,
      skipped: rows.length - created.length,
      duplicates,
      errors,
      message: `Imported ${created.length} of ${rows.length} vendors${errors.length ? `. Skipped: ${errors.join("; ")}` : ""}`,
    });
  } catch (error) {
    console.error("Vendor Import Error:", error);
    res.status(statusForError(error)).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// vendor from the browser. Vendors that still have purchase bills are skipped
// and reported back.
const bulkDeleteVendors = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No vendor ids provided" });
    if (!ids.every((id) => isObjectId(id))) return res.status(400).json({ message: "Invalid vendor id in list" });

    const vendors = await Vendor.find(tenantScope(req, { _id: { $in: ids } })).select("_id company_name").lean();
    const billCounts = await countBills(vendors.map((v) => v._id), req);
    const billsById = new Map(billCounts.map((b) => [String(b._id), b.bills]));

    const skipped = vendors
      .filter((v) => billsById.has(String(v._id)))
      .map((v) => ({ _id: v._id, company_name: v.company_name, bills: billsById.get(String(v._id)) }));
    const deletable = vendors.filter((v) => !billsById.has(String(v._id))).map((v) => v._id);

    const result = deletable.length
      ? await Vendor.deleteMany(tenantScope(req, { _id: { $in: deletable } }))
      : { deletedCount: 0 };
    logActivity(req, `Bulk-deleted ${result.deletedCount} vendor(s)`, { rel_type: "vendor" });

    const skippedMsg = skipped.length
      ? `. Skipped ${skipped.length} with purchase bills: ${skipped.map((s) => `${s.company_name} (${s.bills})`).join(", ")}`
      : "";
    const status = result.deletedCount === 0 && skipped.length > 0 ? 409 : 200;
    res.status(status).json({
      message: `Deleted ${result.deletedCount} vendor(s)${skippedMsg}`,
      deletedCount: result.deletedCount,
      skipped,
    });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

module.exports = {
  getVendors,
  getVendorById,
  getVendorPurchases,
  createVendor,
  updateVendor,
  deleteVendor,
  importVendors,
  bulkDeleteVendors,
};
