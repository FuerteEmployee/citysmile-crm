const mongoose = require("mongoose");
const QuotationType = require("../models/QuotationType");

const tenantFilter = (req) =>
  !req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};

const slugify = (str) =>
  String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const getQuotationTypes = async (req, res) => {
  try {
    const filter = { ...tenantFilter(req) };
    if (req.query.activeOnly === "true") filter.active = true;
    const types = await QuotationType.find(filter).sort({ order: 1, createdAt: 1 });
    res.json(types);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createQuotationType = async (req, res) => {
  try {
    const { name, icon, format, theme, order, active } = req.body;
    if (!name) return res.status(400).json({ message: "name is required" });

    const slug = slugify(name);
    if (!slug) return res.status(400).json({ message: "name must contain at least one letter or number" });

    const exists = await QuotationType.findOne({ slug, ...tenantFilter(req) });
    if (exists) return res.status(400).json({ message: "A quotation type with this name already exists" });

    const last = await QuotationType.findOne(tenantFilter(req)).sort("-order");

    const quotationType = await QuotationType.create({
      name,
      slug,
      icon: icon || "FileBarChart",
      format: format || "both",
      theme: theme || undefined,
      order: order ?? (last ? last.order + 1 : 1),
      active: active !== false,
      tenant_id: req.user?.tenant_id,
      created_by: req.user?._id,
    });

    res.status(201).json(quotationType);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateQuotationType = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation type id" });
    }
    const filter = { _id: req.params.id, ...tenantFilter(req) };
    const update = { ...req.body };
    delete update.tenant_id;
    delete update._id;
    delete update.created_by;
    delete update.createdAt;

    if (update.name) update.slug = slugify(update.name);

    if (update.slug) {
      const clash = await QuotationType.findOne({ slug: update.slug, ...tenantFilter(req), _id: { $ne: req.params.id } });
      if (clash) return res.status(400).json({ message: "A quotation type with this name already exists" });
    }

    const quotationType = await QuotationType.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!quotationType) return res.status(404).json({ message: "Quotation type not found" });
    res.json(quotationType);
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation type id" });
    res.status(400).json({ message: error.message });
  }
};

const deleteQuotationType = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation type id" });
    }
    const filter = { _id: req.params.id, ...tenantFilter(req) };
    const quotationType = await QuotationType.findOneAndDelete(filter);
    if (!quotationType) return res.status(404).json({ message: "Quotation type not found" });
    res.json({ message: "Quotation type removed" });
  } catch (error) {
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid quotation type id" });
    res.status(500).json({ message: error.message });
  }
};

const reorderQuotationTypes = async (req, res) => {
  try {
    const { items } = req.body; // [{ id, order }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items array is required" });
    }
    const filter = tenantFilter(req);
    await QuotationType.bulkWrite(
      items.map(({ id, order }) => ({
        updateOne: { filter: { _id: id, ...filter }, update: { $set: { order } } },
      }))
    );
    const updated = await QuotationType.find(filter).sort({ order: 1, createdAt: 1 });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  getQuotationTypes,
  createQuotationType,
  updateQuotationType,
  deleteQuotationType,
  reorderQuotationTypes,
};
