const mongoose = require("mongoose");
const Shift = require("../models/shift_model");
const User = require("../models/user_model");
const { checkNumber, firstError } = require("../utils/fieldRules");

// Grace periods / late count / overtime rate: no negatives, no text, sane maximums.
const shiftNumberError = (b) => firstError(
  checkNumber("Grace period", b.lateGraceMinutes, { min: 0, max: 120, integer: true }),
  checkNumber("Allowed late count per month", b.allowedLateCountPerMonth, { min: 0, max: 31, integer: true }),
  checkNumber("Grace period after shift end", b.overtimeGraceMinutes, { min: 0, max: 120, integer: true }),
  checkNumber("Early-out grace", b.earlyOutGraceMinutes, { min: 0, max: 120, integer: true }),
  checkNumber("Overtime rate per hour", b.overtimeRatePerHour, { min: 0 }),
  checkNumber("Lunch duration", b.lunch?.durationMinutes, { min: 0, max: 480, integer: true }),
);

exports.createShift = async (req, res) => {
  try {
    const { startTime, endTime } = req.body;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (startTime && !timeRegex.test(startTime)) {
      return res.status(400).json({ success: false, message: "Invalid startTime format. Use HH:mm" });
    }
    if (endTime && !timeRegex.test(endTime)) {
      return res.status(400).json({ success: false, message: "Invalid endTime format. Use HH:mm" });
    }
    const numberError = shiftNumberError(req.body);
    if (numberError) return res.status(400).json({ success: false, message: numberError });

    const shift = new Shift({
      ...req.body,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await shift.save();
    res.status(201).json({ success: true, data: shift });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A shift with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllShifts = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const shifts = await Shift.find(tenantFilter).lean();

    // How many active employees are allocated to each shift (shown on the Shift page).
    const counts = await User.aggregate([
      { $match: { ...tenantFilter, isActive: true, shiftId: { $in: shifts.map((s) => s._id) } } },
      { $group: { _id: "$shiftId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    const data = shifts.map((s) => ({ ...s, employeeCount: countMap.get(String(s._id)) || 0 }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getShiftById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const shift = await Shift.findOne({ _id: req.params.id, ...tenantFilter });
    if (!shift) return res.status(404).json({ success: false, message: "Shift not found" });
    res.status(200).json({ success: true, data: shift });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateShift = async (req, res) => {
  try {
    const { startTime, endTime } = req.body;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (startTime && !timeRegex.test(startTime)) {
      return res.status(400).json({ success: false, message: "Invalid startTime format. Use HH:mm" });
    }
    if (endTime && !timeRegex.test(endTime)) {
      return res.status(400).json({ success: false, message: "Invalid endTime format. Use HH:mm" });
    }

    const numberError = shiftNumberError(req.body);
    if (numberError) return res.status(400).json({ success: false, message: numberError });

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint
    const shift = await Shift.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, body, { returnDocument: "after", runValidators: true });
    if (!shift) return res.status(404).json({ success: false, message: "Shift not found" });
    res.status(200).json({ success: true, data: shift });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A shift with this name already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /shifts/:id/assign  { userIds: [...] }
// Bulk shift allocation: moves every listed employee onto this shift (replacing
// whatever shift they had). Scoped to the requester's tenant on both sides.
exports.assignShift = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const shift = await Shift.findOne({ _id: req.params.id, ...tenantFilter }).select("_id name");
    if (!shift) return res.status(404).json({ success: false, message: "Shift not found" });

    const userIds = (Array.isArray(req.body.userIds) ? req.body.userIds : [])
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (userIds.length === 0) {
      return res.status(400).json({ success: false, message: "Select at least one employee" });
    }

    const result = await User.updateMany(
      { _id: { $in: userIds }, ...tenantFilter },
      { $set: { shiftId: shift._id } }
    );

    res.status(200).json({
      success: true,
      message: `${result.modifiedCount} employee(s) assigned to ${shift.name}`,
      data: { matched: result.matchedCount, modified: result.modifiedCount },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const shift = await Shift.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!shift) return res.status(404).json({ success: false, message: "Shift not found" });
    res.status(200).json({ success: true, message: "Shift deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
