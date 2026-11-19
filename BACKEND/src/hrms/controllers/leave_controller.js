const LeaveRequest = require("../models/leave_request_model");
const LeaveType = require("../models/leave_type_model");
const LeaveBalance = require("../models/leave_balance_model");
const { scopedUserIds, canActOnEmployee, OUT_OF_SCOPE_MESSAGE } = require("../utils/branchScope");
const { checkNumber } = require("../utils/fieldRules");

// Leave types a company can use: its own plus the shared defaults (tenant_id null).
const tenantOf = (req) => (req.user?.is_superadmin ? null : (req.user?.tenant_id || null));
const leaveTypesVisibleTo = (req) => ({ tenant_id: { $in: [tenantOf(req), null] } });

// Calendar day (UTC midnight) of a "YYYY-MM-DD" or ISO date, or null if it isn't a date.
const dayOf = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) + "T00:00:00Z" : v);
  return isNaN(d.getTime()) ? null : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// From/To must be real dates in order, and Total Days must fit inside that range.
function leaveRequestError({ fromDate, toDate, totalDays }) {
  const from = dayOf(fromDate);
  const to = dayOf(toDate);
  if (from === null || to === null) return "Please provide valid From and To dates";
  if (to < from) return "To date cannot be before From date";
  const rangeDays = Math.round((to - from) / 86400000) + 1;
  const n = Number(totalDays);
  if (!Number.isFinite(n) || n <= 0) return "Total days must be greater than 0";
  if (Math.round(n * 2) !== n * 2) return "Total days must be in whole or half days";
  if (n > rangeDays) return `Total days (${n}) cannot be more than the ${rangeDays} day(s) between From and To`;
  return null;
}

exports.createLeaveRequest = async (req, res) => {
  try {
    const invalid = leaveRequestError(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const userId = req.user.userId || req.user.id;
    console.log("DEBUG: createLeaveRequest", { userId, body: req.body });
    const { leaveTypeId, totalDays, isHalfDay, halfDayPeriod, fromDate, toDate, reason, attachmentUrl } = req.body;
    const mongoose = require("mongoose");

    let leaveType;
    if (mongoose.Types.ObjectId.isValid(leaveTypeId)) {
      leaveType = await LeaveType.findOne({ _id: leaveTypeId, ...leaveTypesVisibleTo(req) });
    } else {
      // Check if the shared default leave types exist. If not, lazy-seed them (tenant_id null = shared).
      const anyType = await LeaveType.findOne({ tenant_id: null });
      if (!anyType) {
        await LeaveType.create([
          { name: "Sick Leave", code: "SL", yearlyQuota: 12 },
          { name: "Casual Leave", code: "CL", yearlyQuota: 12 },
          { name: "Earned Leave", code: "EL", yearlyQuota: 15 },
          { name: "Paid Leave", code: "PL", yearlyQuota: 10 },
        ]);
      }

      // Fallback for mock/fallback IDs: try searching by name or code
      const searchName = leaveTypeId.replace("_id", "").replace("_", " ");
      // The company's own type wins over a shared default with the same name/code.
      leaveType = await LeaveType.findOne({
        ...leaveTypesVisibleTo(req),
        $or: [
          { name: new RegExp(searchName, "i") },
          { code: leaveTypeId.replace("_id", "").toUpperCase() }
        ]
      }).sort({ tenant_id: -1 });
    }

    if (!leaveType) return res.status(404).json({ success: false, message: "Leave type not found. Please ensure leave types are configured in the system." });

    const currentYear = new Date().getFullYear();

    // Map halfDayPeriod to match enum in model ["First Half", "Second Half"]
    let formattedHalfDayPeriod = halfDayPeriod;
    if (halfDayPeriod === "first_half") formattedHalfDayPeriod = "First Half";
    if (halfDayPeriod === "second_half") formattedHalfDayPeriod = "Second Half";

    let balanceDoc = null;
    if (leaveType.isPaid) {
      let balance = await LeaveBalance.findOne({ employeeId: userId, leaveTypeId: leaveType._id, year: currentYear });
      if (!balance) {
        balance = new LeaveBalance({
          employeeId: userId,
          leaveTypeId: leaveType._id,
          year: currentYear,
          totalAllocated: leaveType.yearlyQuota
        });
        await balance.save();
      }
      
      // Insufficient-balance check removed to match the reference project's behavior
      // (employees can request leave beyond their allocated balance).
      balanceDoc = balance;
    }

    // Check for overlapping pending or approved leave requests for this employee
    const overlappingLeave = await LeaveRequest.findOne({
      employeeId: userId,
      status: { $in: ["Pending", "Approved"] },
      fromDate: { $lte: toDate },
      toDate: { $gte: fromDate },
    });
    if (overlappingLeave) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending or approved leave request for overlapping dates.",
      });
    }

    const leave = new LeaveRequest({
      employeeId: userId,
      leaveTypeId: leaveType._id,
      fromDate,
      toDate,
      totalDays,
      isHalfDay,
      halfDayPeriod: formattedHalfDayPeriod,
      reason,
      attachmentUrl,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });

    await leave.save();
    
    if (balanceDoc) {
      await LeaveBalance.updateOne(
        { _id: balanceDoc._id },
        { $inc: { pending: totalDays } }
      );
    }
    res.status(201).json({ success: true, data: leave });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getLeaveRequests = async (req, res) => {
  try {
    const { status, employeeId, startDate, endDate, page, limit } = req.query;
    let query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    if (status) query.status = status;
    if (employeeId) query.employeeId = employeeId;

    // Branch supervisors only see leave of staff in their branches.
    const allowedIds = await scopedUserIds(req);
    if (allowedIds) {
      if (employeeId && !allowedIds.some((id) => String(id) === String(employeeId))) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
      if (!employeeId) query.employeeId = { $in: allowedIds };
    }

    if (startDate || endDate) {
      query.fromDate = {};
      if (startDate) query.fromDate.$gte = new Date(startDate);
      if (endDate) query.fromDate.$lte = new Date(endDate);
    }

    // Opt-in pagination: only paginate when page/limit is explicitly sent —
    // no current caller sends either, so the default keeps the exact legacy
    // unbounded response shape (used by e.g. MyLeavesPage.tsx).
    const isPaginated = page !== undefined || limit !== undefined;

    if (!isPaginated) {
      const leaves = await LeaveRequest.find(query)
        .sort({ createdAt: -1 })
        .populate("employeeId", "name email role")
        .populate("leaveTypeId", "name code isPaid")
        .populate("approvedBy", "name");

      return res.status(200).json({ success: true, count: leaves.length, data: leaves });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, rows] = await Promise.all([
      LeaveRequest.countDocuments(query),
      LeaveRequest.find(query)
        .sort({ createdAt: -1 })
        .populate("employeeId", "name email role")
        .populate("leaveTypeId", "name code isPaid")
        .populate("approvedBy", "name")
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.status(200).json({
      success: true,
      count: rows.length,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      data: rows,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const approvedBy = req.user.userId || req.user.id;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const leave = await LeaveRequest.findOne({ _id: req.params.id, ...tenantFilter }).populate("leaveTypeId");
    if (!leave) return res.status(404).json({ success: false, message: "Leave request not found" });
    if (!["approved", "rejected", "cancelled", "pending"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be approved, rejected, cancelled or pending" });
    }
    // An employee may withdraw their own still-pending request; anything else needs a manager.
    const selfCancel = String(leave.employeeId) === String(approvedBy) && status === "cancelled" && leave.status === "pending";
    if (!selfCancel && !(await canActOnEmployee(req, leave.employeeId, ["view_leaves"]))) {
      return res.status(403).json({ success: false, message: "You don't have permission to approve or reject this leave" });
    }

    const leaveType = leave.leaveTypeId;
    const currentYear = new Date(leave.fromDate).getFullYear();

    if (leaveType.isPaid && leave.status !== status) {
      let updateQuery = null;
      if (leave.status === "pending" && status === "approved") {
        updateQuery = { $inc: { pending: -leave.totalDays, used: leave.totalDays } };
      } else if (leave.status === "pending" && status === "rejected") {
        updateQuery = { $inc: { pending: -leave.totalDays } };
      } else if (leave.status === "approved" && status === "cancelled") {
        updateQuery = { $inc: { used: -leave.totalDays } };
      }
      
      if (updateQuery) {
        await LeaveBalance.updateOne(
          { employeeId: leave.employeeId, leaveTypeId: leaveType._id, year: currentYear },
          updateQuery
        );
      }
    }

    leave.status = status;
    leave.remarks = remarks;
    leave.approvedBy = approvedBy;
    await leave.save();

    res.status(200).json({ success: true, data: leave });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getLeaveBalances = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const currentYear = new Date().getFullYear();

    const balances = await LeaveBalance.find({ employeeId: userId, year: currentYear })
      .populate("leaveTypeId", "name code isPaid yearlyQuota");

    res.status(200).json({ success: true, data: balances });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Leave Types Handlers
exports.createLeaveType = async (req, res) => {
  try {
    const invalid = checkNumber("Yearly quota", req.body.yearlyQuota, { min: 0, max: 366 });
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const tenant_id = tenantOf(req);
    const code = String(req.body.code || "").trim().toUpperCase();
    if (code && (await LeaveType.exists({ tenant_id, code }))) {
      return res.status(400).json({ success: false, message: `A leave type with code ${code} already exists.` });
    }
    const leaveType = new LeaveType({ ...req.body, tenant_id });
    await leaveType.save();
    res.status(201).json({ success: true, data: leaveType });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A leave type with this code already exists." });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

// The company's own types, plus each shared default whose code the company hasn't replaced.
exports.getLeaveTypes = async (req, res) => {
  try {
    const all = await LeaveType.find({ isActive: true, ...leaveTypesVisibleTo(req) });
    const ownCodes = new Set(all.filter((t) => t.tenant_id).map((t) => t.code));
    const leaveTypes = all.filter((t) => t.tenant_id || !ownCodes.has(t.code));
    res.status(200).json({ success: true, count: leaveTypes.length, data: leaveTypes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
