const Reminder = require("../models/Reminder");
const Lead = require("../models/Lead");
const LeadStatus = require("../models/LeadStatus");
const LeadSource = require("../models/LeadSource");
const LeadConversion = require("../models/LeadConversion");
const { tenantFilter } = require("./leadScope");
const { dayRange } = require("../utils/appDate");

// Legacy reminders have no `status`, so "pending" is "not completed/dismissed".
const PENDING = { status: { $nin: ["completed", "dismissed"] } };

// Reminder buckets (business timezone, non-overlapping):
//   overdue  — pending, scheduled before today
//   today    — pending, scheduled any time today (UI flags the ones already past)
//   upcoming — pending, scheduled after today
const bucketDateFilter = (bucket) => {
  const { start, end } = dayRange();
  if (bucket === "overdue") return { date: { $lt: start } };
  if (bucket === "today") return { date: { $gte: start, $lt: end } };
  if (bucket === "upcoming") return { date: { $gte: end } };
  return {};
};

const pendingLeadReminderFilter = (req, bucket = "any") => ({
  ...tenantFilter(req),
  rel_type: "lead",
  ...PENDING,
  ...bucketDateFilter(bucket),
});

// Lead ids that have a pending reminder in the bucket (tenant-scoped; callers
// intersect with their own lead scope).
const reminderLeadIds = (req, bucket = "any") =>
  Reminder.distinct("rel_id", pendingLeadReminderFilter(req, bucket));

const whatsappSourceIds = (req) =>
  LeadSource.find({ ...tenantFilter(req), name: { $regex: /^whatsapp$/i } }).distinct("_id");

// A lead counts as a WhatsApp lead if the WhatsApp integration created it, or
// staff tagged it with the "WhatsApp" source manually.
const whatsappLeadCondition = async (req) => ({
  $or: [{ origin: "whatsapp" }, { source: { $in: await whatsappSourceIds(req) } }],
});

const confirmedStatusIds = (req) =>
  LeadStatus.find({ ...tenantFilter(req), name: { $regex: /^confirm/i } }).distinct("_id");

// Adds next_reminder / reminder_bucket / conversion to each lead of a page.
const attachLeadInsights = async (leadObjs, tFilter) => {
  if (!leadObjs.length) return leadObjs;
  const ids = leadObjs.map((l) => l._id);

  const [reminders, conversions] = await Promise.all([
    Reminder.find({ ...tFilter, rel_type: "lead", rel_id: { $in: ids }, ...PENDING })
      .sort({ date: 1 })
      .select("rel_id date description staff")
      .lean(),
    LeadConversion.find({ ...tFilter, lead: { $in: ids } })
      .select("lead treatment_name treatment_amount converted_at client")
      .lean(),
  ]);

  const { start, end } = dayRange();
  const nextByLead = new Map();
  const pendingCount = new Map();
  for (const r of reminders) {
    const key = String(r.rel_id);
    pendingCount.set(key, (pendingCount.get(key) || 0) + 1);
    if (!nextByLead.has(key)) nextByLead.set(key, r);
  }
  const convByLead = new Map(conversions.map((c) => [String(c.lead), c]));

  return leadObjs.map((lead) => {
    const key = String(lead._id);
    const next = nextByLead.get(key);
    let bucket = null;
    if (next) {
      const t = new Date(next.date).getTime();
      bucket = t < start.getTime() ? "overdue" : t < end.getTime() ? "today" : "upcoming";
    }
    const conv = convByLead.get(key);
    return {
      ...lead,
      next_reminder: next
        ? { _id: next._id, date: next.date, description: next.description, staff: next.staff }
        : null,
      reminder_bucket: bucket,
      pending_reminders: pendingCount.get(key) || 0,
      conversion: conv
        ? {
            _id: conv._id,
            treatment_name: conv.treatment_name,
            treatment_amount: conv.treatment_amount,
            converted_at: conv.converted_at,
            client: conv.client,
          }
        : null,
    };
  });
};

// Recommended pipeline. Matching is by alias, so an existing "Followup" or
// "Customer" status counts and is never duplicated.
const PIPELINE_STATUSES = [
  { name: "New", color: "#2563eb", match: /^new$/i },
  { name: "Contacted", color: "#0891b2", match: /^contacted$/i },
  { name: "Follow-up", color: "#d97706", match: /^follow[\s-]?up$/i },
  { name: "Confirmed", color: "#7c3aed", match: /^confirm(ed)?$/i },
  { name: "Converted", color: "#16a34a", match: /^(converted|customer)$/i },
];

const getMissingPipelineStatuses = async (tenantId) => {
  const existing = await LeadStatus.find({ tenant_id: tenantId }).select("name").lean();
  return PIPELINE_STATUSES.filter((p) => !existing.some((s) => p.match.test(String(s.name || "").trim()))).map(
    (p) => p.name
  );
};

const ensurePipelineStatuses = async (tenantId) => {
  const missing = await getMissingPipelineStatuses(tenantId);
  if (!missing.length) return [];
  const last = await LeadStatus.findOne({ tenant_id: tenantId }).sort({ statusorder: -1 }).select("statusorder");
  let order = (last?.statusorder || 0) + 1;
  const created = [];
  for (const def of PIPELINE_STATUSES.filter((p) => missing.includes(p.name))) {
    try {
      created.push(
        await LeadStatus.create({ name: def.name, color: def.color, statusorder: order++, tenant_id: tenantId })
      );
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return created;
};

// Status a converted lead moves to: existing "Converted"/"Customer", else a
// newly created "Converted".
const getConvertedStatus = async (tenantId) => {
  const existing = await LeadStatus.findOne({ tenant_id: tenantId, name: { $regex: /^(converted|customer)$/i } });
  if (existing) return existing;
  try {
    const last = await LeadStatus.findOne({ tenant_id: tenantId }).sort({ statusorder: -1 }).select("statusorder");
    return await LeadStatus.create({
      name: "Converted",
      color: "#16a34a",
      statusorder: (last?.statusorder || 0) + 1,
      tenant_id: tenantId,
    });
  } catch (err) {
    if (err.code === 11000) return LeadStatus.findOne({ tenant_id: tenantId, name: "Converted" });
    throw err;
  }
};

// Keeps the existing Lead.followup_date column in sync with the lead's
// earliest pending reminder (cleared when none are left).
const syncLeadFollowup = async (leadId) => {
  if (!leadId) return;
  const next = await Reminder.findOne({ rel_id: leadId, rel_type: "lead", ...PENDING }).sort({ date: 1 }).select("date");
  await Lead.updateOne({ _id: leadId }, { followup_date: next ? next.date : null, followup_notified: false });
};

module.exports = {
  PENDING,
  bucketDateFilter,
  pendingLeadReminderFilter,
  reminderLeadIds,
  whatsappSourceIds,
  whatsappLeadCondition,
  confirmedStatusIds,
  attachLeadInsights,
  PIPELINE_STATUSES,
  getMissingPipelineStatuses,
  ensurePipelineStatuses,
  getConvertedStatus,
  syncLeadFollowup,
};
