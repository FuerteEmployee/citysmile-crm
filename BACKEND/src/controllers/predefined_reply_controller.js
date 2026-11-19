const PredefinedReply = require("../models/PredefinedReply");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getReplies = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const replies = await PredefinedReply.find(filter).sort({ createdAt: -1 });
    res.status(200).json(replies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createReply = async (req, res) => {
  try {
    const rawName = req.body?.name;
    const rawMessage = req.body?.message;

    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Reply name is required" });
    }
    if (!rawMessage || !String(rawMessage).trim()) {
      return res.status(400).json({ message: "Reply message is required" });
    }

    const trimmedName = String(rawName).trim();
    const trimmedMessage = String(rawMessage).trim();

    const existing = await PredefinedReply.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A predefined reply with this name already exists" });
    }

    const newReply = await PredefinedReply.create({
      ...req.body,
      name: trimmedName,
      message: trimmedMessage,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json(newReply);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateReply = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const reply = await PredefinedReply.findOne(filter);
    if (!reply) return res.status(404).json({ message: "Predefined reply not found" });

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) return res.status(400).json({ message: "Reply name is required" });

      const duplicate = await PredefinedReply.findOne({
        _id: { $ne: reply._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A predefined reply with this name already exists" });
      }

      reply.name = trimmedName;
    }

    if (req.body.message !== undefined) {
      const trimmedMessage = String(req.body.message).trim();
      if (!trimmedMessage) return res.status(400).json({ message: "Reply message is required" });
      reply.message = trimmedMessage;
    }

    const updatedReply = await reply.save();
    res.status(200).json(updatedReply);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteReply = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const reply = await PredefinedReply.findOne(filter);
    if (!reply) return res.status(404).json({ message: "Predefined reply not found" });

    await reply.deleteOne();
    res.status(200).json({ message: "Deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateReply = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid data" });

    const validItems = items
      .map((g) => {
        const parts = String(g).split("|");
        return {
          name: parts[0]?.trim() || "",
          message: parts[1]?.trim() || parts[0]?.trim() || "",
        };
      })
      .filter((g) => g.name);

    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const existing = await PredefinedReply.find({
      name: { $in: validItems.map((g) => new RegExp(`^${escapeRegex(g.name)}$`, "i")) },
      tenant_id: req.user?.tenant_id,
    }).select("name");

    const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const toInsert = [];
    const seen = new Set();

    for (const item of validItems) {
      const lower = item.name.toLowerCase();
      if (!existingNames.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        toInsert.push({ ...item, tenant_id: req.user?.tenant_id });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "All specified replies already exist" });
    }

    const createdItems = await PredefinedReply.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getReplies,
  createReply,
  updateReply,
  deleteReply,
  bulkCreateReply,
};
