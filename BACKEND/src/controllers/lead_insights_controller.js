const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Reminder = require("../models/Reminder");
const LeadConversion = require("../models/LeadConversion");
const MarketingSpend = require("../models/MarketingSpend");
const { leadScopeFilter, tenantFilter, isGlobalScope } = require("../services/leadScope");
const {
  pendingLeadReminderFilter,
  whatsappLeadCondition,
  confirmedStatusIds,
  getMissingPipelineStatuses,
  ensurePipelineStatuses,
} = require("../services/leadInsightsService");
const { dayRange, monthRange, APP_TIMEZONE } = require("../utils/appDate");
const { logActivity } = require("../services/ActivityLogService");
const { getTenantFeatures } = require("../utils/tenantFeatures");
const { TENANT_FEATURE_KEYS } = require("../config/tenantFeatures");
const { hasCapability } = require("../middleware/auth");

const and = (...parts) => ({ $and: parts.filter((p) => p && Object.keys(p).length) });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isAdmin = (req) => !!(req.user?.admin || req.user?.is_superadmin);

// Own-scope users only see reminders/conversions for leads they can see.
const scopedLeadIdsOrNull = async (req) =>
  isGlobalScope(req) ? null : Lead.find(leadScopeFilter(req)).distinct("_id");

const sumSpend = async (match) => {
  const [row] = await MarketingSpend.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
  return round2(row?.total);
};

// GET /api/leads/overview — every number on the Leads overview cards.
const getOverview = async (req, res) => {
  try {
    const scope = leadScopeFilter(req);
    const tf = tenantFilter(req);
    const today = dayRange();
    const month = monthRange();
    const inRange = (r) => ({ $gte: r.start, $lt: r.end });

    const [waCond, confirmedIds, scopedIds, featureSet, canViewSpend] = await Promise.all([
      whatsappLeadCondition(req),
      confirmedStatusIds(req),
      scopedLeadIdsOrNull(req),
      req.user?.is_superadmin ? new Set(TENANT_FEATURE_KEYS) : getTenantFeatures(req.user?.tenant_id),
      hasCapability(req, "Marketing Spend", "View(Global)"),
    ]);
    const on = (key) => featureSet.has(key);
    const skip = (key, promise) => (on(key) ? promise : Promise.resolve(null));

    const reminderBase = pendingLeadReminderFilter(req, "any");
    if (scopedIds) reminderBase.rel_id = { $in: scopedIds };
    const reminderIn = (bucket) => {
      const f = pendingLeadReminderFilter(req, bucket);
      if (scopedIds) f.rel_id = { $in: scopedIds };
      return f;
    };

    const convBase = { ...tf };
    if (scopedIds) convBase.lead = { $in: scopedIds };

    const [
      total, leadsToday, leadsMonth, whatsapp, confirmed, converted,
      remToday, remOverdue, remUpcoming, pendingLeadIds,
      treatmentAgg,
    ] = await Promise.all([
      Lead.countDocuments(scope),
      Lead.countDocuments(and(scope, { createdAt: inRange(today) })),
      Lead.countDocuments(and(scope, { createdAt: inRange(month) })),
      Lead.countDocuments(and(scope, waCond)),
      Lead.countDocuments(and(scope, { status: { $in: confirmedIds } })),
      Lead.countDocuments(and(scope, { converted: true })),
      skip("lead_followups", Reminder.countDocuments(reminderIn("today"))),
      skip("lead_followups", Reminder.countDocuments(reminderIn("overdue"))),
      skip("lead_followups", Reminder.countDocuments(reminderIn("upcoming"))),
      skip("lead_followups", Reminder.distinct("rel_id", reminderBase)),
      skip("patient_conversion", LeadConversion.aggregate([
        { $match: convBase },
        {
          $facet: {
            all: [{ $group: { _id: null, amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } }],
            today: [
              { $match: { converted_at: inRange(today) } },
              { $group: { _id: null, amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } },
            ],
            month: [
              { $match: { converted_at: inRange(month) } },
              { $group: { _id: null, amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } },
            ],
            whatsapp: [
              { $match: { is_whatsapp: true } },
              { $group: { _id: null, amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } },
            ],
            bySource: [
              { $group: { _id: "$source_name", amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } },
              { $sort: { amount: -1 } },
              { $limit: 10 },
            ],
            byCampaign: [
              { $match: { campaign: { $nin: ["", null] } } },
              { $group: { _id: "$campaign", amount: { $sum: "$treatment_amount" }, count: { $sum: 1 } } },
              { $sort: { amount: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ])),
    ]);

    const confirmedPending = pendingLeadIds
      ? await Lead.countDocuments(and(scope, { status: { $in: confirmedIds } }, { _id: { $in: pendingLeadIds } }))
      : 0;

    const facet = treatmentAgg?.[0] || {};
    const pick = (arr) => ({ amount: round2(arr?.[0]?.amount), count: arr?.[0]?.count || 0 });

    // Ad spend is tenant-wide marketing data: needs the company feature plus
    // the "Marketing Spend" role permission.
    let spend = null;
    if (on("marketing_spend") && canViewSpend) {
      const [spendToday, spendMonth, spendTotal, tenantLeadsMonth, tenantLeadsToday] = await Promise.all([
        sumSpend({ ...tf, date: inRange(today) }),
        sumSpend({ ...tf, date: inRange(month) }),
        sumSpend({ ...tf }),
        Lead.countDocuments({ ...tf, createdAt: inRange(month) }),
        Lead.countDocuments({ ...tf, createdAt: inRange(today) }),
      ]);
      spend = {
        today: spendToday,
        month: spendMonth,
        total: spendTotal,
        leadsToday: tenantLeadsToday,
        leadsMonth: tenantLeadsMonth,
        costPerLeadToday: tenantLeadsToday ? round2(spendToday / tenantLeadsToday) : null,
        costPerLeadMonth: tenantLeadsMonth ? round2(spendMonth / tenantLeadsMonth) : null,
      };
    }

    const treatment = !on("patient_conversion") ? null : {
      total: pick(facet.all).amount,
      count: pick(facet.all).count,
      today: pick(facet.today).amount,
      todayCount: pick(facet.today).count,
      month: pick(facet.month).amount,
      monthCount: pick(facet.month).count,
      whatsapp: pick(facet.whatsapp).amount,
      whatsappCount: pick(facet.whatsapp).count,
      bySource: (facet.bySource || []).map((s) => ({ name: s._id || "Unknown", amount: round2(s.amount), count: s.count })),
      byCampaign: (facet.byCampaign || []).map((s) => ({ name: s._id, amount: round2(s.amount), count: s.count })),
    };
    if (spend) spend.roiMonth = spend.month && treatment ? round2(treatment.month / spend.month) : null;

    res.json({
      timezone: APP_TIMEZONE,
      features: [...featureSet],
      leads: {
        total,
        today: leadsToday,
        month: leadsMonth,
        whatsapp,
        confirmed,
        converted,
        conversionRate: total ? round2((converted / total) * 100) : 0,
      },
      reminders: on("lead_followups")
        ? { today: remToday, overdue: remOverdue, upcoming: remUpcoming, confirmedPending }
        : null,
      spend,
      treatment,
      pipeline: {
        missing: req.user?.tenant_id ? await getMissingPipelineStatuses(req.user.tenant_id) : [],
        canSetup: isAdmin(req),
      },
    });
  } catch (error) {
    console.error("[Leads overview] failed:", error);
    res.status(500).json({ message: error.message });
  }
};

// GET /api/leads/follow-ups?bucket=today|overdue|upcoming&limit=
const getFollowUps = async (req, res) => {
  try {
    const bucket = ["today", "overdue", "upcoming"].includes(req.query.bucket) ? req.query.bucket : "today";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const filter = pendingLeadReminderFilter(req, bucket);
    const scopedIds = await scopedLeadIdsOrNull(req);
    if (scopedIds) filter.rel_id = { $in: scopedIds };

    const reminders = await Reminder.find(filter)
      .sort({ date: bucket === "overdue" ? -1 : 1 })
      .limit(limit)
      .populate("staff", "firstname lastname")
      .lean();

    const leads = await Lead.find({ _id: { $in: reminders.map((r) => r.rel_id) } })
      .select("name phonenumber status source assigned converted campaign origin")
      .populate("status", "name color")
      .populate("source", "name")
      .lean();
    const leadById = new Map(leads.map((l) => [String(l._id), l]));

    res.json(
      reminders
        .map((r) => ({ ...r, lead: leadById.get(String(r.rel_id)) || null }))
        .filter((r) => r.lead)
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/leads/conversions — converted patient records.
const getConversions = async (req, res) => {
  try {
    const { dateFrom, dateTo, source, whatsapp } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);

    const filter = { ...tenantFilter(req) };
    const scopedIds = await scopedLeadIdsOrNull(req);
    if (scopedIds) filter.lead = { $in: scopedIds };
    if (dateFrom || dateTo) {
      filter.converted_at = {};
      if (dateFrom) filter.converted_at.$gte = new Date(dateFrom);
      if (dateTo) filter.converted_at.$lte = new Date(dateTo);
    }
    if (source && mongoose.Types.ObjectId.isValid(source)) filter.source = source;
    if (whatsapp === "1" || whatsapp === "true") filter.is_whatsapp = true;

    const [total, sumRow, data] = await Promise.all([
      LeadConversion.countDocuments(filter),
      LeadConversion.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: "$treatment_amount" } } }]),
      LeadConversion.find(filter)
        .sort({ converted_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("lead", "name phonenumber email")
        .populate("client", "company phonenumber")
        .populate("converted_by", "firstname lastname")
        .populate("treatment_item", "name rate")
        .lean(),
    ]);

    res.json({ data, total, page, pages: Math.max(Math.ceil(total / limit), 1), totalAmount: round2(sumRow[0]?.amount) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /api/leads/conversions/:id — admin-only correction of a conversion record.
const updateConversion = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const conversion = await LeadConversion.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!conversion) return res.status(404).json({ message: "Conversion not found" });

    const { treatment_name, treatment_amount, notes } = req.body || {};
    const before = conversion.treatment_amount;
    if (treatment_amount !== undefined) {
      const amount = Number(treatment_amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) {
        return res.status(400).json({ message: "treatment_amount must be a number of 0 or more" });
      }
      conversion.treatment_amount = round2(amount);
    }
    if (treatment_name !== undefined) {
      const name = String(treatment_name).trim();
      if (!name) return res.status(400).json({ message: "treatment_name cannot be empty" });
      conversion.treatment_name = name.slice(0, 200);
    }
    if (notes !== undefined) conversion.notes = String(notes).slice(0, 2000);
    await conversion.save();

    logActivity(
      req,
      `Corrected conversion: ${conversion.treatment_name} amount ${before} → ${conversion.treatment_amount}`,
      { rel_id: conversion.lead, rel_type: "lead" }
    );
    res.json(conversion);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/leads/pipeline-statuses — admin-only: create the recommended
// pipeline statuses the tenant doesn't have yet (never duplicates).
const setupPipelineStatuses = async (req, res) => {
  try {
    if (!req.user?.tenant_id) return res.status(400).json({ message: "No tenant on this account" });
    const created = await ensurePipelineStatuses(req.user.tenant_id);
    res.json({ created: created.map((s) => s.name), message: created.length ? "Pipeline statuses added" : "Nothing to add" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getOverview, getFollowUps, getConversions, updateConversion, setupPipelineStatuses };
