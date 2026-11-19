// Works out how far each goal has got, from the staff member's real activity
// between the goal's start and end date, and sends the "achieved" / "failed"
// notifications (once each) when notify_on_achieve / notify_on_fail are on.
const mongoose = require("mongoose");
const Goal = require("../models/Goal");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Contract = require("../models/Contract");
const Estimate = require("../models/Estimate");
const ContractType = require("../models/ContractType");

const endOfDay = (d) => {
  const e = new Date(d);
  e.setUTCHours(23, 59, 59, 999);
  return e;
};

// Match on `field` inside the range, or on createdAt when `field` was never set.
const inRange = (field, from, to) => ({
  $or: [
    { [field]: { $gte: from, $lte: to } },
    { [field]: null, createdAt: { $gte: from, $lte: to } },
  ],
});

const sum = async (Model, match, field) => {
  const [row] = await Model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: `$${field}` } } }]);
  return row?.v || 0;
};

const contractTypeValues = async (goal) => {
  if (!goal.contract_type) return [];
  const id = goal.contract_type._id || goal.contract_type;
  const values = [id, String(id)];
  const type = await ContractType.findById(id).select("name").lean();
  if (type?.name) {
    values.push(type.name, type.name.toLowerCase(), type.name.trim().toLowerCase().replace(/\s+/g, "_"));
  }
  return values;
};

/** Current value (amount or count) the goal's staff member has reached. */
const currentValue = async (goal) => {
  const staff = new mongoose.Types.ObjectId(String(goal.staff_member?._id || goal.staff_member));
  const tenant_id = goal.tenant_id;
  const from = new Date(goal.start_date);
  const to = endOfDay(goal.end_date);

  switch (goal.goal_type) {
    case "total_income": {
      const invoiceIds = await Invoice.find({ tenant_id, created_by: staff }).distinct("_id");
      return sum(Payment, {
        tenant_id,
        $and: [
          { $or: [{ created_by: staff }, { invoice: { $in: invoiceIds } }] },
          inRange("date", from, to),
        ],
      }, "amount");
    }
    case "invoiced_amount":
      return sum(Invoice, {
        tenant_id,
        created_by: staff,
        status: { $nin: ["cancelled", "draft"] },
        ...inRange("date", from, to),
      }, "total");
    case "convert_leads":
      return Lead.countDocuments({ tenant_id, assigned: staff, converted: true, ...inRange("converted_at", from, to) });
    case "customer_num_include":
    case "customer_num_exclude": {
      const match = { tenant_id, created_by: staff, createdAt: { $gte: from, $lte: to } };
      if (goal.goal_type === "customer_num_exclude") {
        match._id = { $nin: await Lead.find({ tenant_id, client_id: { $ne: null } }).distinct("client_id") };
      }
      return Client.countDocuments(match);
    }
    case "contracts_by_type_added":
    case "contracts_by_type_start": {
      const types = await contractTypeValues(goal);
      if (!types.length) return 0;
      const dateField = goal.goal_type === "contracts_by_type_start" ? "datestart" : "createdAt";
      return Contract.countDocuments({ tenant_id, created_by: staff, contract_type: { $in: types }, [dateField]: { $gte: from, $lte: to } });
    }
    case "estimates_conversion":
      return Estimate.countDocuments({
        tenant_id,
        invoice_id: { $ne: null },
        $and: [
          { $or: [{ created_by: staff }, { sale_agent: String(staff) }] },
          inRange("date", from, to),
        ],
      });
    default:
      return 0;
  }
};

const notify = (io, goal, event) => {
  try {
    if (!io) return;
    const staffId = String(goal.staff_member?._id || goal.staff_member);
    io.to(staffId).emit("goalUpdate", { event, goalId: String(goal._id), subject: goal.subject });
  } catch (err) {
    console.error("[goals] notify failed:", err.message);
  }
};

/**
 * Recalculates progress for the given goal documents (in place), saves any change
 * and sends the achieved / failed notification once. Never throws: a goal whose
 * calculation fails keeps its stored progress.
 */
const refreshProgress = async (goals, io) => {
  const now = new Date();
  await Promise.all(goals.map(async (goal) => {
    try {
      const value = await currentValue(goal);
      const target = Number(goal.achievement) || 0;
      const progress = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
      const update = {};
      if (progress !== goal.progress) update.progress = progress;
      if (progress >= 100 && goal.notify_on_achieve && !goal.achieved_notified_at) {
        update.achieved_notified_at = now;
        notify(io, goal, "achieved");
      } else if (progress < 100 && goal.end_date && endOfDay(goal.end_date) < now && goal.notify_on_fail && !goal.failed_notified_at) {
        update.failed_notified_at = now;
        notify(io, goal, "failed");
      }
      if (Object.keys(update).length) {
        await Goal.updateOne({ _id: goal._id }, { $set: update });
        Object.assign(goal, update);
      }
      goal.current_value = value;
    } catch (err) {
      console.error(`[goals] progress for ${goal._id} failed:`, err.message);
    }
  }));
  return goals;
};

module.exports = { refreshProgress, currentValue };
