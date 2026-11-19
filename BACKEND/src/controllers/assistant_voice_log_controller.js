const mongoose = require("mongoose");
const AssistantVoiceLog = require("../models/AssistantVoiceLog");
const { VOICE_LOG_EVENTS } = require("../models/AssistantVoiceLog");

const MAX_BATCH = 50;
const clip = (v, n) => String(v ?? "").slice(0, n);

const staffName = (user) =>
  [user?.firstname, user?.lastname].filter(Boolean).join(" ") || user?.email || "";

// Shared writer — also used by assistant_controller to log AI replies/errors
// server-side (where the real provider error is known). Never throws: logging
// must not break the feature it observes.
const writeVoiceLogs = async (req, events) => {
  try {
    const docs = events
      .filter((e) => e && VOICE_LOG_EVENTS.includes(e.event))
      .slice(0, MAX_BATCH)
      .map((e) => ({
        tenant_id: req.user?.tenant_id?._id || req.user?.tenant_id || null,
        user_id: req.user?._id,
        user_name: staffName(req.user),
        event: e.event,
        source: ["voice", "typed"].includes(e.source) ? e.source : "",
        heard: clip(e.heard, 500),
        result: clip(e.result, 500),
        detail: clip(e.detail, 500),
        page: clip(e.page, 200),
        browser: clip(e.browser, 100),
        session_id: clip(e.session_id, 64),
      }));
    if (docs.length) await AssistantVoiceLog.insertMany(docs, { ordered: false });
    return docs.length;
  } catch (err) {
    console.error("[CRM Agent logs] write failed:", err.message);
    return 0;
  }
};

// POST /api/assistant/voice-logs — batch of events from the browser
const createVoiceLogs = async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (!events.length) return res.status(400).json({ message: "events array is required" });
  const saved = await writeVoiceLogs(req, events);
  res.status(201).json({ saved });
};

// GET /api/assistant/voice-logs — admin view: filters, paging and per-event counts
const getVoiceLogs = async (req, res) => {
  try {
    const { event, user_id, from, to, q } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = {};
    // Admins only ever see their own company; platform super admins see everything.
    if (!req.user.is_superadmin) filter.tenant_id = req.user.tenant_id?._id || req.user.tenant_id || null;
    if (user_id && mongoose.Types.ObjectId.isValid(user_id)) filter.user_id = new mongoose.Types.ObjectId(user_id);
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ heard: rx }, { result: rx }, { detail: rx }, { user_name: rx }];
    }

    // Counts ignore the event filter so the summary cards always show the full picture.
    const countsAgg = AssistantVoiceLog.aggregate([
      { $match: filter },
      { $group: { _id: "$event", count: { $sum: 1 } } },
    ]);
    const usersAgg = AssistantVoiceLog.aggregate([
      { $match: filter.tenant_id !== undefined ? { tenant_id: filter.tenant_id } : {} },
      { $group: { _id: "$user_id", name: { $last: "$user_name" } } },
      { $sort: { name: 1 } },
    ]);

    const listFilter = { ...filter };
    if (event && VOICE_LOG_EVENTS.includes(event)) listFilter.event = event;

    const [logs, total, counts, users] = await Promise.all([
      AssistantVoiceLog.find(listFilter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AssistantVoiceLog.countDocuments(listFilter),
      countsAgg,
      usersAgg,
    ]);

    res.json({
      logs,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
      users: users.filter((u) => u._id).map((u) => ({ _id: u._id, name: u.name })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { writeVoiceLogs, createVoiceLogs, getVoiceLogs };
