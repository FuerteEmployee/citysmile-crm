const LeadStatus = require("../models/LeadStatus");
const Lead = require("../models/Lead");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getLeadStatuses = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const statuses = await LeadStatus.find(filter).sort({ statusorder: 1 });

    const leadScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;

    const statusesWithCount = await Promise.all(
      statuses.map(async (status) => {
        const count = await Lead.countDocuments({ ...leadScope, status: status._id });
        return { ...status.toObject(), totalLeads: count };
      })
    );
    res.json(statusesWithCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLeadStatus = async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Status name is required" });
    }

    const trimmedName = String(rawName).trim();

    const existing = await LeadStatus.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A lead status with this name already exists" });
    }

    const status = await LeadStatus.create({
      ...req.body,
      name: trimmedName,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json({
      ...status.toObject(),
      totalLeads: 0,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "A lead status with this name already exists" });
    }
    res.status(400).json({ message: error.message });
  }
};

const updateLeadStatus = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const status = await LeadStatus.findOne(filter);
    if (!status) {
      return res.status(404).json({ message: "Lead status not found" });
    }

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Status name is required" });
      }

      const duplicate = await LeadStatus.findOne({
        _id: { $ne: status._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A lead status with this name already exists" });
      }

      req.body.name = trimmedName;
    }

    Object.assign(status, req.body);
    const updatedStatus = await status.save();

    const leadScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;
    const count = await Lead.countDocuments({ ...leadScope, status: updatedStatus._id });

    res.json({
      ...updatedStatus.toObject(),
      totalLeads: count,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "A lead status with this name already exists" });
    }
    res.status(400).json({ message: error.message });
  }
};

const deleteLeadStatus = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const status = await LeadStatus.findOne(filter);
    if (!status) {
      return res.status(404).json({ message: "Lead status not found" });
    }

    // Check if any leads use this status
    const leadScope = { status: status._id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) leadScope.tenant_id = req.user.tenant_id;
    const leadCount = await Lead.countDocuments(leadScope);

    if (leadCount > 0) {
      return res.status(400).json({ message: "Cannot delete status used by leads" });
    }

    await status.deleteOne();
    res.json({ message: "Lead status removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateStatus = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });

    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter(Boolean);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const existing = await LeadStatus.find({
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
      return res.status(400).json({ message: "All specified lead statuses already exist" });
    }

    const createdItems = await LeadStatus.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "One or more of these lead status names already exist." });
    }
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreateStatus,
  getLeadStatuses,
  createLeadStatus,
  updateLeadStatus,
  deleteLeadStatus,
};
