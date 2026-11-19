const Holiday = require("../models/holiday_model");
const { isRealDate } = require("../utils/fieldRules");

// Accepts "YYYY-MM-DD" (a real calendar day) or anything Date can parse; returns "YYYY-MM-DD" or null.
const normalizeDate = (input) => {
  if (!input) return null;
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) return isRealDate(input) ? input : null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Does a holiday apply to an employee's branch? Shared with payroll/jobs.
const holidayAppliesToBranch = (holiday, ...branchLikeIds) => {
  if (!holiday.branchIds || holiday.branchIds.length === 0) return true;
  const ids = branchLikeIds.filter(Boolean).map(String);
  return holiday.branchIds.some((b) => ids.includes(String(b._id || b)));
};

const tenantFilterFor = (req) => ({
  tenant_id: req.user?.is_superadmin ? (req.query?.tenant_id || undefined) : (req.user?.tenant_id || null),
});

exports.createHoliday = async (req, res) => {
  try {
    const date = normalizeDate(req.body.date);
    if (!req.body.name || !date) {
      return res.status(400).json({ success: false, message: "Please provide name and a valid date (YYYY-MM-DD)" });
    }
    const endDate = normalizeDate(req.body.endDate) || date;
    if (endDate < date) {
      return res.status(400).json({ success: false, message: "endDate cannot be before the start date" });
    }
    const tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);
    if (await Holiday.exists({ tenant_id, date, name: String(req.body.name).trim() })) {
      return res.status(400).json({ success: false, message: "A holiday with this name already exists on this date." });
    }

    const holiday = new Holiday({
      ...req.body,
      date,
      endDate,
      branchIds: Array.isArray(req.body.branchIds) ? req.body.branchIds.filter(Boolean) : [],
      tenant_id,
      createdBy: req.user.userId || req.user.id,
    });
    await holiday.save();
    await holiday.populate("branchIds", "name");
    res.status(201).json({ success: true, data: holiday });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A holiday with this name already exists on this date." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/hrms/holidays?year=&month=&date=&branchId=&includeInactive=
exports.getHolidays = async (req, res) => {
  try {
    const { year, month, date, branchId, includeInactive } = req.query;
    const query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const and = [];

    // Range-aware filters: a holiday [date..endDate] matches a day/window when
    // the two intervals overlap. The `endDate: null` branch covers any doc
    // saved before endDate existed.
    const overlapping = (fromStr, toStr) => {
      and.push({ date: { $lte: toStr } });
      and.push({
        $or: [
          { endDate: { $gte: fromStr } },
          { endDate: null, date: { $gte: fromStr } },
        ],
      });
    };

    if (date) {
      const d = normalizeDate(date);
      if (d) overlapping(d, d);
    } else if (year && month) {
      const y = parseInt(year, 10);
      const m = String(parseInt(month, 10)).padStart(2, "0");
      overlapping(`${y}-${m}-01`, `${y}-${m}-31`);
    } else if (year) {
      const y = parseInt(year, 10);
      overlapping(`${y}-01-01`, `${y}-12-31`);
    }

    if (includeInactive !== "true") query.isActive = { $ne: false };

    if (branchId) {
      and.push({ $or: [{ branchIds: { $size: 0 } }, { branchIds: branchId }] });
    }

    if (and.length) query.$and = and;

    const holidays = await Holiday.find(query)
      .populate("branchIds", "name")
      .sort({ date: 1 });

    res.status(200).json({ success: true, count: holidays.length, data: holidays });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getHolidayById = async (req, res) => {
  try {
    const tenantFilter = tenantFilterFor(req);
    const holiday = await Holiday.findOne({ _id: req.params.id, ...tenantFilter }).populate("branchIds", "name");
    if (!holiday) return res.status(404).json({ success: false, message: "Holiday not found" });
    res.status(200).json({ success: true, data: holiday });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateHoliday = async (req, res) => {
  try {
    const tenantFilter = tenantFilterFor(req);
    const holiday = await Holiday.findOne({ _id: req.params.id, ...tenantFilter });
    if (!holiday) return res.status(404).json({ success: false, message: "Holiday not found" });

    const update = { ...req.body };
    delete update.tenant_id; // never reassignable via this endpoint
    if (update.date !== undefined) {
      const date = normalizeDate(update.date);
      if (!date) return res.status(400).json({ success: false, message: "Invalid date — use YYYY-MM-DD" });
      update.date = date;
    }
    if (update.endDate !== undefined) {
      // Clearing endDate collapses the holiday back to a single day.
      update.endDate = normalizeDate(update.endDate) || update.date || holiday.date;
    }
    if (update.branchIds !== undefined) {
      update.branchIds = Array.isArray(update.branchIds) ? update.branchIds.filter(Boolean) : [];
    }

    Object.assign(holiday, update);
    await holiday.save(); // runs the pre-validate hook (endDate default + range check)
    await holiday.populate("branchIds", "name");

    res.status(200).json({ success: true, data: holiday });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A holiday with this name already exists on this date." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteHoliday = async (req, res) => {
  try {
    const tenantFilter = tenantFilterFor(req);
    const holiday = await Holiday.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!holiday) return res.status(404).json({ success: false, message: "Holiday not found" });
    res.status(200).json({ success: true, message: "Holiday deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.holidayAppliesToBranch = holidayAppliesToBranch;
