const LeadSource = require("../models/LeadSource");
const Lead = require("../models/Lead");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getLeadSources = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const sources = await LeadSource.find(filter).sort({ name: 1 });

    const leadScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;

    const sourcesWithCount = await Promise.all(
      sources.map(async (source) => {
        const count = await Lead.countDocuments({ ...leadScope, source: source._id });
        return { ...source.toObject(), totalLeads: count };
      })
    );
    res.json(sourcesWithCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLeadSource = async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Source name is required" });
    }

    const trimmedName = String(rawName).trim();

    const existing = await LeadSource.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A lead source with this name already exists" });
    }

    const source = await LeadSource.create({
      ...req.body,
      name: trimmedName,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json({
      ...source.toObject(),
      totalLeads: 0,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateLeadSource = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const source = await LeadSource.findOne(filter);
    if (!source) {
      return res.status(404).json({ message: "Lead source not found" });
    }

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Source name is required" });
      }

      const duplicate = await LeadSource.findOne({
        _id: { $ne: source._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A lead source with this name already exists" });
      }

      req.body.name = trimmedName;
    }

    Object.assign(source, req.body);
    const updatedSource = await source.save();

    const leadScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;
    const count = await Lead.countDocuments({ ...leadScope, source: updatedSource._id });

    res.json({
      ...updatedSource.toObject(),
      totalLeads: count,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteLeadSource = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const source = await LeadSource.findOne(filter);
    if (!source) {
      return res.status(404).json({ message: "Lead source not found" });
    }

    // Check if any leads use this source
    const leadScope = { source: source._id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;
    const leadCount = await Lead.countDocuments(leadScope);

    if (leadCount > 0) {
      return res.status(400).json({ message: "Cannot delete source used by leads" });
    }

    await source.deleteOne();
    res.json({ message: "Lead source removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateSource = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });

    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter(Boolean);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const existing = await LeadSource.find({
      name: { $in: validItems.map((g) => new RegExp(`^${escapeRegex(g)}$`, "i")) },
      tenant_id: req.user?.tenant_id,
    }).select("name");

    const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const toInsert = [];
    const seen = new Set();

    for (const name of validItems) {
      const lower = name.toLowerCase();
      if (!existingNames.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        toInsert.push({ name, tenant_id: req.user?.tenant_id });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "All specified lead sources already exist" });
    }

    const createdItems = await LeadSource.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreateSource,
  getLeadSources,
  createLeadSource,
  updateLeadSource,
  deleteLeadSource,
};
