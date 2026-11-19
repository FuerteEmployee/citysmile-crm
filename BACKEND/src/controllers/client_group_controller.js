const ClientGroup = require("../models/ClientGroup");
const Client = require("../models/Client");
const { isObjectId, statusForError } = require("../utils/requestSafety");
const { tenantScope, escapeRegExp, HTML_TAG } = require("../utils/customerRules");

// Group names are unique per company (ClientGroup index); a clash is a clear 409.
const DUPLICATE_MSG = (name) => `A customer group named "${name}" already exists`;

const checkName = (name) => {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return { error: "Group name is required" };
  if (n.length > 100) return { error: "Group name must be 100 characters or less" };
  if (HTML_TAG.test(n)) return { error: "Group name must not contain HTML tags" };
  return { name: n };
};
const sameNameInCompany = (req, name, excludeId) =>
  ClientGroup.exists({
    ...tenantScope(req),
    name: new RegExp(`^${escapeRegExp(name)}$`, "i"),
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
const sendError = (res, error, name) =>
  (error?.code === 11000
    ? res.status(409).json({ message: DUPLICATE_MSG(name || "") })
    : res.status(statusForError(error)).json({ message: error.message }));

const findOwnGroup = (req) =>
  (isObjectId(String(req.params.id)) ? ClientGroup.findOne({ _id: req.params.id, ...tenantScope(req) }) : null);

// Number of this company's customers in a group.
const customerCount = (req, groupId) => Client.countDocuments({ ...tenantScope(req), groups: groupId });

const getGroups = async (req, res) => {
  try {
    const groups = await ClientGroup.find(tenantScope(req)).sort({ name: 1 }).lean();
    // One grouped count for all groups instead of a query per group.
    const counts = await Client.aggregate([
      { $match: { ...tenantScope(req), groups: { $in: groups.map((g) => g._id) } } },
      { $unwind: "$groups" },
      { $group: { _id: "$groups", n: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json(groups.map((g) => ({ ...g, totalCustomers: byId.get(String(g._id)) || 0 })));
  } catch (error) {
    sendError(res, error);
  }
};

const createGroup = async (req, res) => {
  const { error, name } = checkName(req.body?.name);
  if (error) return res.status(400).json({ message: error });
  try {
    if (await sameNameInCompany(req, name)) return res.status(409).json({ message: DUPLICATE_MSG(name) });
    const group = await ClientGroup.create({ name, tenant_id: req.user?.tenant_id });
    res.status(201).json({ ...group.toObject(), totalCustomers: 0 });
  } catch (error) {
    sendError(res, error, name);
  }
};

const updateGroup = async (req, res) => {
  const { error, name } = checkName(req.body?.name);
  if (error) return res.status(400).json({ message: error });
  try {
    const group = await findOwnGroup(req);
    if (!group) return res.status(404).json({ message: "Group not found" });
    if (await sameNameInCompany(req, name, group._id)) return res.status(409).json({ message: DUPLICATE_MSG(name) });
    group.name = name;
    const saved = await group.save();
    res.json({ ...saved.toObject(), totalCustomers: await customerCount(req, saved._id) });
  } catch (error) {
    sendError(res, error, name);
  }
};

const deleteGroup = async (req, res) => {
  try {
    const group = await findOwnGroup(req);
    if (!group) return res.status(404).json({ message: "Group not found" });
    await group.deleteOne();
    // Drop the deleted group from this company's customers so no dangling ids remain.
    await Client.updateMany({ ...tenantScope(req), groups: group._id }, { $pull: { groups: group._id } });
    res.json({ message: "Group removed" });
  } catch (error) {
    sendError(res, error);
  }
};

const bulkCreateGroup = async (req, res) => {
  try {
    const { groups } = req.body || {};
    if (!groups || !Array.isArray(groups)) {
      return res.status(400).json({ message: "Invalid groups data" });
    }
    const seen = new Set();
    const validGroups = [];
    for (const g of groups) {
      const { error, name } = checkName(g);
      if (error) continue;
      const key = name.toLowerCase();
      if (seen.has(key) || (await sameNameInCompany(req, name))) continue;
      seen.add(key);
      validGroups.push(name);
    }
    if (validGroups.length === 0) {
      return res.status(400).json({ message: "No new valid group names provided" });
    }
    const createdGroups = await ClientGroup.insertMany(validGroups.map((name) => ({ name, tenant_id: req.user?.tenant_id })));
    res.status(201).json(createdGroups);
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = { getGroups, createGroup, updateGroup, deleteGroup, bulkCreateGroup };
