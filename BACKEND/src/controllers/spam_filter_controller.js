const SpamFilter = require("../models/SpamFilter");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getSpamFilters = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const filters = await SpamFilter.find(filter).sort({ createdAt: -1 });
    res.json(filters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createSpamFilter = async (req, res) => {
  try {
    const rawValue = req.body?.value;
    const type = req.body?.type || "sender";

    if (!rawValue || !String(rawValue).trim()) {
      return res.status(400).json({ message: "Filter value is required" });
    }

    if (!["sender", "subject", "phrase"].includes(type)) {
      return res.status(400).json({ message: "Invalid filter type" });
    }

    const trimmedValue = String(rawValue).trim();

    const existing = await SpamFilter.findOne({
      type,
      value: { $regex: new RegExp(`^${escapeRegex(trimmedValue)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A spam filter with this type and value already exists" });
    }

    const filter = await SpamFilter.create({
      ...req.body,
      type,
      value: trimmedValue,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json(filter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateSpamFilter = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const filter = await SpamFilter.findOne(query);
    if (!filter) {
      return res.status(404).json({ message: "Spam filter not found" });
    }

    const nextType = req.body.type || filter.type;
    const nextValue = req.body.value !== undefined ? String(req.body.value).trim() : filter.value;

    if (!nextValue) {
      return res.status(400).json({ message: "Filter value is required" });
    }

    if (!["sender", "subject", "phrase"].includes(nextType)) {
      return res.status(400).json({ message: "Invalid filter type" });
    }

    const duplicate = await SpamFilter.findOne({
      _id: { $ne: filter._id },
      type: nextType,
      value: { $regex: new RegExp(`^${escapeRegex(nextValue)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (duplicate) {
      return res.status(400).json({ message: "A spam filter with this type and value already exists" });
    }

    Object.assign(filter, req.body, { type: nextType, value: nextValue });
    const updatedFilter = await filter.save();
    res.json(updatedFilter);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteSpamFilter = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const filter = await SpamFilter.findOne(query);
    if (!filter) {
      return res.status(404).json({ message: "Spam filter not found" });
    }

    await filter.deleteOne();
    res.json({ message: "Spam filter removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getSpamFilters,
  createSpamFilter,
  updateSpamFilter,
  deleteSpamFilter,
};
