// Setup > Settings > Tags: the tags actually used on the company's records
// (they are stored on each record, not in a separate table).

// [model, label] — models whose `tags` is a string array.
const ARRAY_TAG_MODELS = [
  ["Invoice", "Invoices"],
  ["Estimate", "Estimates"],
  ["Project", "Projects"],
  ["Ticket", "Tickets"],
  ["Task", "Tasks"],
];

const tenantScope = (req) => (!req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {});
const splitLeadTags = (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean);

const getTags = async (req, res) => {
  try {
    const scope = tenantScope(req);
    const counts = new Map(); // tag -> { tag, count, modules:Set }
    const add = (tag, n, label) => {
      const key = String(tag).trim();
      if (!key) return;
      const row = counts.get(key.toLowerCase()) || { tag: key, count: 0, modules: new Set() };
      row.count += n;
      row.modules.add(label);
      counts.set(key.toLowerCase(), row);
    };

    for (const [name, label] of ARRAY_TAG_MODELS) {
      const Model = require(`../models/${name}`);
      const rows = await Model.aggregate([
        { $match: { ...scope, tags: { $exists: true, $ne: [] } } },
        { $unwind: "$tags" },
        { $group: { _id: "$tags", n: { $sum: 1 } } },
      ]);
      rows.forEach((r) => add(r._id, r.n, label));
    }
    // Leads keep tags as one comma separated string.
    const Lead = require("../models/Lead");
    const leads = await Lead.find({ ...scope, tags: { $nin: [null, ""] } }).select("tags").lean();
    leads.forEach((l) => splitLeadTags(l.tags).forEach((t) => add(t, 1, "Leads")));

    const list = [...counts.values()]
      .map((r) => ({ tag: r.tag, count: r.count, modules: [...r.modules] }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Removes the tag from every record of the company. */
const deleteTag = async (req, res) => {
  try {
    const tag = String(req.params.tag || "").trim();
    if (!tag) return res.status(400).json({ message: "Tag is required" });
    const scope = tenantScope(req);
    const exact = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    let removedFrom = 0;
    for (const [name] of ARRAY_TAG_MODELS) {
      const r = await require(`../models/${name}`).updateMany({ ...scope, tags: exact }, { $pull: { tags: exact } });
      removedFrom += r.modifiedCount || 0;
    }
    const Lead = require("../models/Lead");
    const leads = await Lead.find({ ...scope, tags: { $regex: tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }).select("tags");
    for (const lead of leads) {
      const kept = splitLeadTags(lead.tags).filter((t) => t.toLowerCase() !== tag.toLowerCase());
      if (kept.length !== splitLeadTags(lead.tags).length) {
        lead.tags = kept.join(", ");
        await lead.save({ validateBeforeSave: false });
        removedFrom++;
      }
    }
    res.json({ message: `Tag "${tag}" removed from ${removedFrom} record(s)`, removedFrom });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getTags, deleteTag };
