const mongoose = require("mongoose");
const MarketingSpend = require("../models/MarketingSpend");
const LeadSource = require("../models/LeadSource");
const Lead = require("../models/Lead");
const { tenantFilter } = require("../services/leadScope");
const { logActivity } = require("../services/ActivityLogService");
const { APP_TIMEZONE, toDayString, startOfDay, addDays, dayRange, monthRange, isValidDay } = require("../utils/appDate");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_AMOUNT = 100000000;

// Lead counts per (day, source, campaign) in [startDay, endDayExclusive).
const leadCountsByDay = async (tf, start, end) => {
  const rows = await Lead.aggregate([
    { $match: { ...tf, createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: APP_TIMEZONE } },
          source: "$source",
          campaign: "$campaign",
        },
        count: { $sum: 1 },
      },
    },
  ]);
  return rows.map((r) => ({
    day: r._id.day,
    source: r._id.source ? String(r._id.source) : null,
    campaign: r._id.campaign || "",
    count: r.count,
  }));
};

// Leads attributable to a spend row: same day, and same source / campaign
// when the row is tied to one (a row with neither counts all that day's leads).
const leadsForRow = (row, counts) =>
  counts
    .filter(
      (c) =>
        c.day === row.day &&
        (!row.source || c.source === String(row.source)) &&
        (!row.campaign || c.campaign === row.campaign)
    )
    .reduce((sum, c) => sum + c.count, 0);

const validatePayload = async (req, body, { partial = false } = {}) => {
  const out = {};
  if (!partial || body.day !== undefined) {
    if (!isValidDay(body.day)) return { error: "day must be a date in YYYY-MM-DD format" };
    if (body.day > toDayString()) return { error: "Spend cannot be recorded for a future date" };
    out.day = body.day;
    out.date = startOfDay(body.day);
  }
  if (!partial || body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
      return { error: "amount must be a number of 0 or more" };
    }
    out.amount = round2(amount);
  }
  if (body.source !== undefined) {
    if (body.source === null || body.source === "" || body.source === "none") {
      out.source = null;
      out.source_name = "";
    } else {
      if (!mongoose.Types.ObjectId.isValid(body.source)) return { error: "Invalid source" };
      const src = await LeadSource.findOne({ _id: body.source, ...tenantFilter(req) }).select("name");
      if (!src) return { error: "Lead source not found" };
      out.source = src._id;
      out.source_name = src.name;
    }
  }
  if (body.campaign !== undefined) out.campaign = String(body.campaign || "").trim().slice(0, 200);
  if (body.notes !== undefined) out.notes = String(body.notes || "").slice(0, 1000);
  return { data: out };
};

// GET /api/marketing-spend?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&source=&campaign=
const listSpend = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const toDay = isValidDay(req.query.dateTo) ? req.query.dateTo : toDayString();
    const fromDay = isValidDay(req.query.dateFrom) ? req.query.dateFrom : addDays(toDay, -29);
    const start = startOfDay(fromDay);
    const end = startOfDay(addDays(toDay, 1));

    const filter = { ...tf, date: { $gte: start, $lt: end } };
    if (req.query.source && mongoose.Types.ObjectId.isValid(req.query.source)) filter.source = req.query.source;
    if (req.query.campaign) filter.campaign = String(req.query.campaign);

    const [rows, counts] = await Promise.all([
      MarketingSpend.find(filter).sort({ date: -1, source_name: 1 }).populate("created_by", "firstname lastname").lean(),
      leadCountsByDay(tf, start, end),
    ]);

    const data = rows.map((row) => {
      const leads = leadsForRow(row, counts);
      return { ...row, leads_count: leads, cost_per_lead: leads ? round2(row.amount / leads) : null };
    });
    const totalAmount = round2(data.reduce((s, r) => s + r.amount, 0));
    const totalLeads = counts.reduce((s, c) => s + c.count, 0);

    res.json({
      data,
      range: { from: fromDay, to: toDay },
      totals: {
        amount: totalAmount,
        leads: totalLeads,
        costPerLead: totalLeads ? round2(totalAmount / totalLeads) : null,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/marketing-spend/summary — today/month totals + per-source CPL.
const getSpendSummary = async (req, res) => {
  try {
    const tf = tenantFilter(req);
    const today = dayRange();
    const month = monthRange();

    const sumIn = async (range) => {
      const [row] = await MarketingSpend.aggregate([
        { $match: { ...tf, date: { $gte: range.start, $lt: range.end } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      return round2(row?.total);
    };

    const [spendToday, spendMonth, leadsToday, leadsMonth, spendBySource, leadsBySource] = await Promise.all([
      sumIn(today),
      sumIn(month),
      Lead.countDocuments({ ...tf, createdAt: { $gte: today.start, $lt: today.end } }),
      Lead.countDocuments({ ...tf, createdAt: { $gte: month.start, $lt: month.end } }),
      MarketingSpend.aggregate([
        { $match: { ...tf, date: { $gte: month.start, $lt: month.end } } },
        { $group: { _id: "$source", name: { $first: "$source_name" }, amount: { $sum: "$amount" } } },
      ]),
      Lead.aggregate([
        { $match: { ...tf, createdAt: { $gte: month.start, $lt: month.end } } },
        { $group: { _id: "$source", count: { $sum: 1 } } },
      ]),
    ]);

    const leadCountBySource = new Map(leadsBySource.map((l) => [String(l._id), l.count]));
    const bySource = spendBySource
      .map((s) => {
        // A row with no source is general spend, measured against all leads.
        const leads = s._id ? leadCountBySource.get(String(s._id)) || 0 : leadsMonth;
        return {
          source: s._id,
          name: s._id ? s.name || "Unknown" : "General / all sources",
          amount: round2(s.amount),
          leads,
          costPerLead: leads ? round2(s.amount / leads) : null,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    res.json({
      today: { amount: spendToday, leads: leadsToday, costPerLead: leadsToday ? round2(spendToday / leadsToday) : null },
      month: { amount: spendMonth, leads: leadsMonth, costPerLead: leadsMonth ? round2(spendMonth / leadsMonth) : null },
      bySource,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createSpend = async (req, res) => {
  try {
    const { data, error } = await validatePayload(req, req.body || {});
    if (error) return res.status(400).json({ message: error });
    const spend = await MarketingSpend.create({
      source: null,
      source_name: "",
      campaign: "",
      ...data,
      tenant_id: req.user?.tenant_id,
      created_by: req.user?._id,
      updated_by: req.user?._id,
    });
    logActivity(req, `Recorded marketing spend ${spend.amount} for ${spend.day}${spend.source_name ? ` (${spend.source_name})` : ""}`);
    res.status(201).json(spend);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Spend for this date, source and campaign already exists — edit that entry instead" });
    }
    res.status(500).json({ message: error.message });
  }
};

const updateSpend = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const spend = await MarketingSpend.findOne({ _id: req.params.id, ...tenantFilter(req) });
    if (!spend) return res.status(404).json({ message: "Spend entry not found" });
    if (spend.sync_source === "meta_ads") {
      return res.status(409).json({ message: "This entry is synced from Meta Ads and can't be edited here" });
    }

    const { data, error } = await validatePayload(req, req.body || {}, { partial: true });
    if (error) return res.status(400).json({ message: error });
    const before = spend.amount;
    Object.assign(spend, data, { updated_by: req.user?._id });
    await spend.save();
    logActivity(req, `Updated marketing spend for ${spend.day}: ${before} → ${spend.amount}`);
    res.json(spend);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Spend for this date, source and campaign already exists" });
    }
    res.status(500).json({ message: error.message });
  }
};

const deleteSpend = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const existing = await MarketingSpend.findOne({ _id: req.params.id, ...tenantFilter(req) }).select("sync_source");
    if (!existing) return res.status(404).json({ message: "Spend entry not found" });
    if (existing.sync_source === "meta_ads") {
      return res.status(409).json({ message: "This entry is synced from Meta Ads — disconnect the ad account or change it in Meta" });
    }
    const spend = await MarketingSpend.findOneAndDelete({ _id: existing._id });
    logActivity(req, `Deleted marketing spend ${spend.amount} for ${spend.day}`);
    res.json({ message: "Spend entry removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { listSpend, getSpendSummary, createSpend, updateSpend, deleteSpend };
