const mongoose = require("mongoose");
const Goal = require("../models/Goal");
const Staff = require("../models/Staff");
const ContractType = require("../models/ContractType");
const { refreshProgress } = require("../services/goalProgressService");

// Only these fields can come from the client. tenant_id, progress, _id, createdAt
// and the notified_at stamps are always set by the server.
const EDITABLE = ["subject", "goal_type", "staff_member", "achievement", "start_date", "end_date", "contract_type", "description", "notify_on_achieve", "notify_on_fail"];

class BadRequest extends Error {}

// Superadmins see every tenant; everyone else only their own. A user with no
// tenant gets null, which callers turn into an empty list / 404.
const tenantFilter = (req) => {
  if (req.user?.is_superadmin) return {};
  return req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : null;
};

const sendError = (res, error) => {
  if (error instanceof BadRequest) return res.status(400).json({ message: error.message });
  if (error instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ message: Object.values(error.errors).map((e) => e.message).join(", ") });
  }
  if (error instanceof mongoose.Error.CastError) {
    return res.status(400).json({ message: `Invalid value for ${error.path}` });
  }
  return res.status(500).json({ message: error.message });
};

// "2026-02-30" must not silently become 2 March.
const parseDate = (value, label) => {
  if (value === undefined) return undefined;
  const text = String(value ?? "").trim();
  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) throw new BadRequest(`${label} is not a valid date`);
  if (ymd && (date.getUTCFullYear() !== +ymd[1] || date.getUTCMonth() + 1 !== +ymd[2] || date.getUTCDate() !== +ymd[3])) {
    throw new BadRequest(`${label} is not a valid date`);
  }
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) throw new BadRequest(`${label} must be between 2000 and 2100`);
  return date;
};

const parseBool = (value, label) => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new BadRequest(`${label} must be true or false`);
  return value;
};

/** Picks the editable fields from the body and checks them against the tenant. */
const readBody = async (req, tenant) => {
  const data = {};
  for (const key of EDITABLE) if (req.body?.[key] !== undefined) data[key] = req.body[key];

  if (data.subject !== undefined && typeof data.subject !== "string") throw new BadRequest("Subject must be text");
  if (data.achievement !== undefined) {
    const n = typeof data.achievement === "number" || typeof data.achievement === "string" ? Number(data.achievement) : NaN;
    if (data.achievement === "" || !Number.isFinite(n)) throw new BadRequest("Achievement must be a number greater than 0");
    data.achievement = n;
  }
  if (data.start_date !== undefined) data.start_date = parseDate(data.start_date, "Start date");
  if (data.end_date !== undefined) data.end_date = parseDate(data.end_date, "End date");
  data.notify_on_achieve = parseBool(data.notify_on_achieve, "Notify on achieve");
  data.notify_on_fail = parseBool(data.notify_on_fail, "Notify on fail");
  if (data.notify_on_achieve === undefined) delete data.notify_on_achieve;
  if (data.notify_on_fail === undefined) delete data.notify_on_fail;

  if (data.staff_member !== undefined) {
    if (!mongoose.isValidObjectId(data.staff_member)) throw new BadRequest("Staff member is not valid");
    if (!(await Staff.exists({ _id: data.staff_member, ...tenant }))) throw new BadRequest("Staff member not found");
  }
  if (data.contract_type === "" || data.contract_type === null) data.contract_type = undefined;
  if (data.contract_type !== undefined) {
    if (!mongoose.isValidObjectId(data.contract_type)) throw new BadRequest("Contract type is not valid");
    if (!(await ContractType.exists({ _id: data.contract_type, ...tenant }))) throw new BadRequest("Contract type not found");
  }
  return data;
};

const findOwned = (req, tenant) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequest("Invalid goal id");
  return Goal.findOne({ _id: req.params.id, ...tenant });
};

exports.getGoals = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant) return res.json([]);
    const goals = await Goal.find(tenant).populate("staff_member", "firstname lastname").sort({ createdAt: -1 }).lean();
    await refreshProgress(goals, req.app?.get("io"));
    res.json(goals);
  } catch (error) {
    sendError(res, error);
  }
};

// Staff members and contract types for the goal form. Lives under Goals so a user
// with Goals Create but no Staff permission can still pick a staff member.
exports.getGoalOptions = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant) return res.json({ staff: [], contractTypes: [] });
    const [staff, contractTypes] = await Promise.all([
      Staff.find({ ...tenant, active: { $ne: false } }).select("firstname lastname").sort({ firstname: 1 }).lean(),
      ContractType.find(tenant).select("name").sort({ name: 1 }).lean(),
    ]);
    res.json({ staff, contractTypes });
  } catch (error) {
    sendError(res, error);
  }
};

exports.createGoal = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant?.tenant_id) return res.status(403).json({ message: "Your account is not linked to a company" });
    const data = await readBody(req, tenant);
    if (String(data.goal_type || "").startsWith("contracts_by_type") && !data.contract_type) {
      throw new BadRequest("Contract type is required for contract goals");
    }
    const goal = await Goal.create({ ...data, tenant_id: tenant.tenant_id });
    res.status(201).json(goal);
  } catch (error) {
    sendError(res, error);
  }
};

exports.getGoalById = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant) return res.status(404).json({ message: "Goal not found" });
    const goal = await findOwned(req, tenant).populate("staff_member", "firstname lastname").lean();
    if (!goal) return res.status(404).json({ message: "Goal not found" });
    await refreshProgress([goal], req.app?.get("io"));
    res.json(goal);
  } catch (error) {
    sendError(res, error);
  }
};

exports.updateGoal = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant) return res.status(404).json({ message: "Goal not found" });
    const goal = await findOwned(req, tenant);
    if (!goal) return res.status(404).json({ message: "Goal not found" });
    const data = await readBody(req, goal.tenant_id ? { tenant_id: goal.tenant_id } : tenant);
    goal.set(data);
    await goal.save();
    res.json(goal);
  } catch (error) {
    sendError(res, error);
  }
};

exports.deleteGoal = async (req, res) => {
  try {
    const tenant = tenantFilter(req);
    if (!tenant) return res.status(404).json({ message: "Goal not found" });
    if (!mongoose.isValidObjectId(req.params.id)) throw new BadRequest("Invalid goal id");
    const goal = await Goal.findOneAndDelete({ _id: req.params.id, ...tenant });
    if (!goal) return res.status(404).json({ message: "Goal not found" });
    res.json({ message: "Goal deleted" });
  } catch (error) {
    sendError(res, error);
  }
};
