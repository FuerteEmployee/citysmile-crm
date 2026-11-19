const Priority = require("../models/Priority");
const Ticket = require("../models/Ticket");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getPriorities = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const priorities = await Priority.find(filter).sort({ createdAt: -1 });

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;

    const prioritiesWithCount = await Promise.all(
      priorities.map(async (pri) => {
        const totalTickets = await Ticket.countDocuments({ ...ticketScope, priority: pri._id });
        return {
          ...pri.toObject(),
          totalTickets,
        };
      })
    );

    res.json(prioritiesWithCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createPriority = async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Priority name is required" });
    }

    const trimmedName = String(rawName).trim();

    const existing = await Priority.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A priority with this name already exists" });
    }

    const priority = await Priority.create({
      ...req.body,
      name: trimmedName,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json({
      ...priority.toObject(),
      totalTickets: 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updatePriority = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const priority = await Priority.findOne(filter);
    if (!priority) {
      return res.status(404).json({ message: "Priority not found" });
    }

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Priority name is required" });
      }

      const duplicate = await Priority.findOne({
        _id: { $ne: priority._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A priority with this name already exists" });
      }

      req.body.name = trimmedName;
    }

    Object.assign(priority, req.body);
    const updatedPriority = await priority.save();

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;
    const totalTickets = await Ticket.countDocuments({ ...ticketScope, priority: updatedPriority._id });

    res.json({
      ...updatedPriority.toObject(),
      totalTickets,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deletePriority = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const priority = await Priority.findOne(filter);
    if (!priority) {
      return res.status(404).json({ message: "Priority not found" });
    }

    await priority.deleteOne();
    res.json({ message: "Priority removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreatePriority = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid data" });

    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter(Boolean);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const existing = await Priority.find({
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
      return res.status(400).json({ message: "All specified priorities already exist" });
    }

    const createdItems = await Priority.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreatePriority,
  getPriorities,
  createPriority,
  updatePriority,
  deletePriority,
};
