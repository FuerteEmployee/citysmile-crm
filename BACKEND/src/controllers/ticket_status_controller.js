const TicketStatus = require("../models/TicketStatus");
const Ticket = require("../models/Ticket");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getStatuses = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const statuses = await TicketStatus.find(filter).sort({ statusorder: 1 });

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;

    const statusesWithCount = await Promise.all(
      statuses.map(async (st) => {
        // Tickets status can be stored by name or by status id
        const totalTickets = await Ticket.countDocuments({
          ...ticketScope,
          $or: [{ status: st.name }, { status: st._id.toString() }],
        });
        return {
          ...st.toObject(),
          totalTickets,
        };
      })
    );

    res.json(statusesWithCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createStatus = async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Status name is required" });
    }

    const trimmedName = String(rawName).trim();

    const existing = await TicketStatus.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A ticket status with this name already exists" });
    }

    const status = await TicketStatus.create({
      ...req.body,
      name: trimmedName,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json({
      ...status.toObject(),
      totalTickets: 0,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "A ticket status with this name already exists" });
    }
    res.status(500).json({ message: error.message });
  }
};

const updateStatus = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const status = await TicketStatus.findOne(filter);
    if (!status) {
      return res.status(404).json({ message: "Status not found" });
    }

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Status name is required" });
      }

      const duplicate = await TicketStatus.findOne({
        _id: { $ne: status._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A ticket status with this name already exists" });
      }

      req.body.name = trimmedName;
    }

    Object.assign(status, req.body);
    const updatedStatus = await status.save();

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;
    const totalTickets = await Ticket.countDocuments({
      ...ticketScope,
      $or: [{ status: updatedStatus.name }, { status: updatedStatus._id.toString() }],
    });

    res.json({
      ...updatedStatus.toObject(),
      totalTickets,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "A ticket status with this name already exists" });
    }
    res.status(500).json({ message: error.message });
  }
};

const deleteStatus = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const status = await TicketStatus.findOne(filter);
    if (!status) {
      return res.status(404).json({ message: "Status not found" });
    }

    await status.deleteOne();
    res.json({ message: "Status removed" });
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

    const existing = await TicketStatus.find({
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
      return res.status(400).json({ message: "All specified statuses already exist" });
    }

    const createdItems = await TicketStatus.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getStatuses,
  createStatus,
  updateStatus,
  deleteStatus,
  bulkCreateStatus,
};
