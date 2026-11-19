const PayrollRecord = require("../models/payroll_record_model");
const User = require("../models/user_model");
const Attendance = require("../models/attendance_model");
const LeaveRequest = require("../models/leave_request_model");
const SalaryStructure = require("../models/salary_structure_model");
const Shift = require("../models/shift_model");
const AdvanceSalary = require("../models/advance_salary_model");
const { getISTDate } = require("../utils/timeUtils");

// Gives back to each advance/loan whatever this payslip booked against it
// (balance restored, its installment removed, "Repaid" reopened). Used when an
// unpaid payslip is re-generated or deleted, so nothing is deducted twice.
async function refundBookedAdvances(payrollRecordId) {
  const booked = await AdvanceSalary.find({ "installments.payrollRecordId": payrollRecordId });
  for (const a of booked) {
    const isThisRun = (i) => String(i.payrollRecordId) === String(payrollRecordId);
    const refund = a.installments.filter(isThisRun).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    a.installments = a.installments.filter((i) => !isThisRun(i));
    a.remainingAmount = (Number(a.remainingAmount) || 0) + refund;
    if (a.status === "Repaid" && a.remainingAmount > 0) {
      a.status = "Approved";
      a.repaidInPayrollRecordId = null;
    }
    await a.save();
  }
}

exports.generatePayroll = async (req, res) => {
  try {

    const { month, year } = req.body;
    // No storeId / "all" = every salaried employee of the company ("All
    // Branches"), including staff with no branch assigned.
    const storeId = req.body.storeId && req.body.storeId !== "all" ? req.body.storeId : null;

    if (!month || !year) {
      return res.status(400).json({ success: false, message: "Please provide month and year" });
    }
    const monthNum = Number(month);
    const yearNum = Number(year);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ success: false, message: "Month must be a whole number from 1 to 12" });
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({ success: false, message: "Year must be a valid 4-digit year" });
    }

    // 1. Find all active employees (for the branch, if one was chosen) who have a salary configured
    let queryStoreId = storeId;
    try {
      const mongoose = require("mongoose");
      if (storeId && mongoose.Types.ObjectId.isValid(storeId)) {
        queryStoreId = new mongoose.Types.ObjectId(storeId);
      }
    } catch (e) { }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const branchFilter = storeId
      ? {
          $or: [
            { storeId: queryStoreId },
            { storeId: storeId },
            { hrmsBranchId: queryStoreId },
            { hrmsBranchId: storeId }
          ],
        }
      : {};

    // Salaried = a salary breakdown OR just a Base Salary (the calculation below
    // treats a missing breakdown as "whole Base Salary is Basic").
    const hasSalary = { $or: [{ salaryStructureId: { $exists: true, $ne: null } }, { salaryAmount: { $gt: 0 } }] };
    const employees = await User.find({
      $and: [branchFilter, hasSalary],
      isActive: true,
      ...tenantFilter,
    }).populate("salaryStructureId");

    const results = [];

    for (const emp of employees) {

      // Check if an already paid payroll record exists for this employee, month, and year
      const existingRecord = await PayrollRecord.findOne({
        type: "payroll",
        employeeId: emp._id,
        month,
        year
      });

      if (existingRecord && (existingRecord.status === "paid" || existingRecord.paymentStatus === "Paid")) {
        results.push(existingRecord);
        continue;
      }

      // Re-generating an unpaid month: undo the advance/loan deductions the
      // previous run booked against this payslip before recalculating.
      // Otherwise a loan EMI was deducted twice, and an advance the first run
      // fully recovered (now "Repaid") silently dropped off the new payslip.
      if (existingRecord) await refundBookedAdvances(existingRecord._id);

      // Fetch Attendance for the month timezone-safely
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0); // Last day of month

      const formatLocalYMD = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const startStr = formatLocalYMD(startDate);
      const endStr = formatLocalYMD(endDate);

      const attendance = await Attendance.find({
        userId: emp._id,
        date: { $gte: startStr, $lte: endStr },
        status: { $in: ["Full Day", "Half Day", "Absent"] }
      });

      let presentDays = 0;
      let absentDaysFromAttendance = 0;
      let overtimeMinutes = 0;
      attendance.forEach(a => {
        if (a.status === "Full Day") presentDays += 1;
        else if (a.status === "Half Day") { presentDays += 0.5; absentDaysFromAttendance += 0.5; }
        else if (a.status === "Absent") absentDaysFromAttendance += 1;
        overtimeMinutes += a.overtimeMinutes || 0;
      });

      // Fetch Leaves
      const leaves = await LeaveRequest.find({
        employeeId: emp._id,
        status: "approved",
        fromDate: { $lte: endDate },
        toDate: { $gte: startDate }
      }).populate("leaveTypeId");

      const totalDaysInMonth = endDate.getDate();

      let holidayCount = 0;
      const holidays = (emp.weeklyHolidays && emp.weeklyHolidays.length > 0) ? emp.weeklyHolidays : ["Sunday"];
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const targetDays = holidays.map(h => dayNames.indexOf(h)).filter(d => d !== -1);

      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;

      // Leave counts only working days — a weekly off inside a leave (e.g. the
      // Sunday in a Sat→Mon leave) is already paid as a weekly off below, so
      // counting it as leave too paid it twice. Half-day leave counts 0.5.
      leaves.forEach(l => {
        const lStart = l.fromDate < startDate ? startDate : l.fromDate;
        const lEnd = l.toDate > endDate ? endDate : l.toDate;
        let days = 0;
        for (let d = new Date(lStart.getFullYear(), lStart.getMonth(), lStart.getDate()); d <= lEnd; d.setDate(d.getDate() + 1)) {
          if (!targetDays.includes(d.getDay())) days++;
        }
        if (l.isHalfDay && days > 0) days = 0.5;

        if (l.leaveTypeId && l.leaveTypeId.isPaid) paidLeaveDays += days;
        else unpaidLeaveDays += days;
      });

      for (let d = 1; d <= totalDaysInMonth; d++) {
        const tempDate = new Date(year, month - 1, d);
        if (targetDays.includes(tempDate.getDay())) {
          holidayCount++;
        }
      }

      // Company pay rule (pay for days that have gone by):
      //  • Per day = monthly salary ÷ days in the month (weekly offs are paid
      //    days too), e.g. Oct 2026: ₹25,000 ÷ 31 = ₹806.45/day.
      //  • Paid = days present (Half Day = 0.5) + paid leave + weekly offs
      //    (Sundays) that have ALREADY PASSED on the day payroll is generated.
      //    Upcoming Sundays are not paid in advance on a mid-month run.
      //  • A worked Sunday is paid once, not as present + weekly off.
      //  • No work at all in the month = ₹0 (Sundays aren't paid on their own).
      //  • Full month attended = exactly the full salary; never more.
      const todayStr = getISTDate();
      const cutoffStr = todayStr < endStr ? todayStr : endStr; // last day that has gone by
      const elapsedDays = cutoffStr < startStr ? 0 : Number(cutoffStr.slice(8, 10));

      const workedAnyDay = presentDays + paidLeaveDays > 0;
      let paidWeeklyOffs = 0;
      if (workedAnyDay) {
        const attendedDates = new Set();
        attendance.forEach(a => {
          if (a.status === "Full Day" || a.status === "Half Day") attendedDates.add(String(a.date));
        });
        leaves.forEach(l => {
          if (l.leaveTypeId && l.leaveTypeId.isPaid) {
            const lStart = l.fromDate < startDate ? startDate : l.fromDate;
            const lEnd = l.toDate > endDate ? endDate : l.toDate;
            for (let d = new Date(lStart.getFullYear(), lStart.getMonth(), lStart.getDate()); d <= lEnd; d.setDate(d.getDate() + 1)) {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, "0");
              const day = String(d.getDate()).padStart(2, "0");
              attendedDates.add(`${y}-${m}-${day}`);
            }
          }
        });

        for (let d = 1; d <= elapsedDays; d++) {
          const dt = new Date(year, month - 1, d);
          if (!targetDays.includes(dt.getDay())) continue;

          const dtStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          if (attendedDates.has(dtStr)) {
            paidWeeklyOffs++;
            continue;
          }

          let precedingWorkingAttended = false;
          for (let p = d - 1; p >= 1; p--) {
            const pDate = new Date(year, month - 1, p);
            if (!targetDays.includes(pDate.getDay())) {
              const pStr = `${year}-${String(month).padStart(2, "0")}-${String(p).padStart(2, "0")}`;
              if (attendedDates.has(pStr)) precedingWorkingAttended = true;
              break;
            }
          }

          let followingWorkingAttended = false;
          for (let f = d + 1; f <= totalDaysInMonth; f++) {
            const fDate = new Date(year, month - 1, f);
            if (!targetDays.includes(fDate.getDay())) {
              const fStr = `${year}-${String(month).padStart(2, "0")}-${String(f).padStart(2, "0")}`;
              if (attendedDates.has(fStr)) followingWorkingAttended = true;
              break;
            }
          }

          if (precedingWorkingAttended || followingWorkingAttended) {
            paidWeeklyOffs++;
          }
        }
      }
      let workedOnPaidOffs = 0;
      if (paidWeeklyOffs > 0) {
        attendance.forEach(a => {
          const [y, m, d] = String(a.date).split("-").map(Number);
          if (a.date > cutoffStr || !targetDays.includes(new Date(y, m - 1, d).getDay())) return;
          if (a.status === "Full Day") workedOnPaidOffs += 1;
          else if (a.status === "Half Day") workedOnPaidOffs += 0.5;
        });
      }

      let payableDays = Math.min(totalDaysInMonth, presentDays - workedOnPaidOffs + paidLeaveDays + paidWeeklyOffs);
      let lopDays = Math.max(0, totalDaysInMonth - payableDays);
      // Absent = days already gone that weren't paid and weren't approved unpaid leave.
      const absentDays = Math.max(0, elapsedDays - payableDays - unpaidLeaveDays);

      const factor = Math.max(0, Math.min(1, payableDays / totalDaysInMonth));

      // Determine salary configuration components dynamically
      let basicVal = 0;
      let hraVal = 0;
      let conveyanceVal = 0;
      let medicalVal = 0;
      let specialVal = 0;
      let pfVal = 0;
      let esicVal = 0;
      let ptVal = 0;
      let pfApplicable = false;
      let pfMode = "per_day";
      let pfModeExplicit = false;
      let pfRate = 12;
      let esicApplicable = false;

      if (emp.salaryStructureId) {
        const structure = emp.salaryStructureId;
        basicVal = Number(structure.basic) || 0;
        hraVal = Number(structure.hra) || 0;
        conveyanceVal = Number(structure.conveyance) || 0;
        medicalVal = Number(structure.medicalAllowance) || 0;
        specialVal = Number(structure.specialAllowance) || 0;
        pfApplicable = structure.pfApplicable;
        pfMode = structure.pfMode || "per_day";
        // Mongoose fills the schema default ("per_day") into records saved
        // before PF modes existed — only a value actually stored counts.
        pfModeExplicit = !!structure.pfMode &&
          !(typeof structure.$isDefault === "function" && structure.$isDefault("pfMode"));
        pfRate = Number.isFinite(Number(structure.pfRate)) ? Number(structure.pfRate) : 12;
        esicApplicable = structure.esicApplicable;
        ptVal = Number(structure.professionalTax) || 0;

        if (structure.standardDeductions && Array.isArray(structure.standardDeductions)) {
          const pfDeduction = structure.standardDeductions.find(d => d.name === "PF (Employee)");
          if (pfDeduction) pfVal = Number(pfDeduction.amount) || 0;

          const esicDeduction = structure.standardDeductions.find(d => d.name === "ESIC");
          if (esicDeduction) esicVal = Number(esicDeduction.amount) || 0;
        }

        // Staff saved with only "Base Salary" on the form get a structure whose
        // breakdown is all ₹0 — that used to pay ₹0 and take 12% of ₹0 as PF
        // (per day or fixed). An empty breakdown = the whole Base Salary is Basic.
        if (basicVal + hraVal + conveyanceVal + medicalVal + specialVal <= 0) {
          basicVal = Number(emp.salaryAmount) || 0;
        }
      } else {
        // Default everything to basic salary
        basicVal = Number(emp.salaryAmount) || 0;
      }

      // Calculate Earnings
      const basic = basicVal * factor;
      const hra = hraVal * factor;
      const conveyance = conveyanceVal * factor;
      const medical = medicalVal * factor;
      const special = specialVal * factor;

      // Overtime pay: rate is per-shift (SH-11) — 0 means "track hours only,
      // no payout" (attendance.overtimeMinutes is still stored either way).
      const empShift = emp.shiftId ? await Shift.findById(emp.shiftId).select("overtimeRatePerHour").lean() : null;
      const overtimeRate = Number(empShift?.overtimeRatePerHour) || 0;
      const overtimePay = overtimeRate > 0 ? (overtimeMinutes / 60) * overtimeRate : 0;

      const additions = [];
      if (overtimePay > 0) {
        additions.push({ label: "Overtime", amount: Math.round(overtimePay) || 0 });
      }

      const gross = basic + hra + conveyance + medical + special + overtimePay;

      // Calculate Deductions
      const deductions = [];
      let totalDeductions = 0;
      // PF / ESIC / PT can only come out of what was actually earned — no work,
      // no salary, so nothing to deduct (a "Fixed monthly" PF used to push a
      // zero-attendance month into negative pay).
      const withinEarned = (amount) => Math.max(0, Math.min(amount, gross - totalDeductions));

      if (pfApplicable) {
        // fixed_monthly: the full configured PF (or pfRate% of full basic) every month.
        // per_day (chosen on the form): the amount is PER DAY × paid days, e.g.
        //   ₹20 × 8 days = ₹160. With no amount: pfRate% of the Basic earned.
        // Mode never set (structures saved before PF modes existed): the amount
        //   was a MONTHLY figure — keep scaling it by paid days, as before.
        const pfAmount = withinEarned(
          pfMode === "fixed_monthly"
            ? (pfVal > 0 ? pfVal : basicVal * pfRate / 100)
            : pfVal > 0 && pfModeExplicit
              ? pfVal * payableDays
              : (pfVal > 0 ? pfVal * factor : basicVal * factor * pfRate / 100)
        );
        if (pfAmount > 0) {
          deductions.push({ label: "PF (Employee)", amount: Math.round(pfAmount) || 0 });
          totalDeductions += pfAmount;
        }
      }

      // Statutory rule: ESIC is only applicable when gross monthly wages are <= 21,000
      if (esicApplicable && gross <= 21000) {
        const esicAmount = withinEarned(esicVal > 0 ? (esicVal * factor) : (gross * 0.0075));
        if (esicAmount > 0) {
          deductions.push({ label: "ESIC", amount: Math.round(esicAmount) || 0 });
          totalDeductions += esicAmount;
        }
      }

      if (ptVal) {
        const ptAmount = withinEarned(ptVal * factor);
        if (ptAmount > 0) {
          deductions.push({ label: "PT", amount: Math.round(ptAmount) || 0 });
          totalDeductions += ptAmount;
        }
      }

      // Advance Salary / Loan — "Advance Salary" always deducts its full
      // remaining balance in one shot. A "Loan" with a monthlyInstallmentAmount
      // set (see advance_salary_controller.js — Loan-only) instead deducts just
      // that much per run, capped at whatever's left so the final installment
      // never overshoots. The deduction is booked against the advance/loan
      // balance right here at generation (below, after the payslip is saved);
      // re-generating first gives back what the previous run booked (above).
      const pendingAdvances = await AdvanceSalary.find({
        employeeId: emp._id,
        status: "Approved",
        ...tenantFilter,
      });
      const advanceDeductions = pendingAdvances.map((a) => {
        const remaining = Number(a.remainingAmount ?? a.amount) || 0;
        const installment = Number(a.monthlyInstallmentAmount) || 0;
        const due = installment > 0 ? Math.min(installment, remaining) : remaining;
        return { record: a, amount: due };
      }).filter((d) => d.amount > 0);

      // Never deduct more than the salary left after PF/ESIC/PT — net pay stops
      // at ₹0 and the unrecovered part simply stays on the advance's balance,
      // so it's picked up again by next month's payroll.
      for (const d of advanceDeductions) {
        d.amount = Math.floor(withinEarned(d.amount));
        if (d.amount <= 0) continue;
        const label = d.record.type === "Loan" ? "Loan Repayment" : "Advance Salary Repayment";
        deductions.push({ label, amount: d.amount });
        totalDeductions += d.amount;
      }

      const netSalary = gross - totalDeductions;

      // Create/Update Payroll Record
      const payrollData = {
        type: "payroll",
        employeeId: emp._id,
        storeId: emp.storeId || emp.hrmsBranchId || storeId || null,
        salaryStructureSnapshot: {
          basic: Math.round(basic) || 0,
          hra: Math.round(hra) || 0,
          conveyance: Math.round(conveyance) || 0,
          medicalAllowance: Math.round(medical) || 0,
          specialAllowance: Math.round(special) || 0
        },
        month,
        year,
        payableDays: Number(payableDays) || 0,
        presentDays: Number(presentDays) || 0,
        leaveDays: Number(paidLeaveDays) || 0,
        unpaidLeaveDays: Number(lopDays) || 0,
        absentDays: Number(absentDays) || 0,
        overtimeMinutes: Number(overtimeMinutes) || 0,
        grossSalary: Math.round(gross) || 0,
        netSalary: Math.round(netSalary) || 0,
        additions,
        deductions,
        advanceDeductions: advanceDeductions.filter((d) => d.amount > 0).map(({ record: a, amount }) => ({ advanceId: a._id, amount })),
        status: "generated",
        paymentStatus: "Due",
        generatedAt: new Date(),
        paidAt: null,
        tenant_id: emp.tenant_id || tenantFilter.tenant_id,
      };

      const record = await PayrollRecord.findOneAndUpdate(
        { type: "payroll", employeeId: emp._id, month, year },
        payrollData,
        { upsert: true, returnDocument: 'after' }
      );

      // Book each deduction against its advance/loan now — the balance drops
      // at salary generation, together with the payslip deduction. A Loan
      // with an EMI stays "Approved" until its balance hits 0.
      for (const { record: advRecord, amount } of advanceDeductions) {
        if (amount <= 0) continue;
        const remainingAfter = Math.max(0, (Number(advRecord.remainingAmount ?? advRecord.amount) || 0) - amount);
        const update = {
          $set: { remainingAmount: remainingAfter },
          $push: { installments: { month, year, amount, payrollRecordId: record._id, deductedAt: new Date(), source: "payroll" } },
        };
        if (remainingAfter <= 0) {
          update.$set.status = "Repaid";
          update.$set.repaidInPayrollRecordId = record._id;
        }
        await AdvanceSalary.findByIdAndUpdate(advRecord._id, update);
      }

      results.push(record);
    }

    // Active staff in scope that payroll skipped because no salary is set up —
    // shown on the Salary Management screen so missing payslips are explained.
    const skippedNoSalary = await User.countDocuments({
      $and: [
        branchFilter,
        { $or: [{ salaryStructureId: { $exists: false } }, { salaryStructureId: null }] },
        { $or: [{ salaryAmount: { $exists: false } }, { salaryAmount: { $lte: 0 } }] },
      ],
      isActive: true,
      ...tenantFilter,
    });

    res.status(200).json({ success: true, count: results.length, skippedNoSalary, data: results });
  } catch (error) {
    console.error("PAYROLL_GENERATION_ERROR:", error);
    try {
      require("fs").writeFileSync("payroll_error_log.txt", error.stack || String(error));
    } catch (e) { }
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPayrollRecords = async (req, res) => {
  try {
    const { month, year, storeId, employeeId } = req.query;
    let query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    if (month) query.month = parseInt(month);
    if (year) query.year = parseInt(year);

    if (storeId) {
      let storeIdObj = storeId;
      try {
        const mongoose = require("mongoose");
        if (mongoose.Types.ObjectId.isValid(storeId)) {
          storeIdObj = new mongoose.Types.ObjectId(storeId);
        }
      } catch (e) { }
      query.$or = [
        { storeId: { $in: [storeId, storeIdObj] } },
        { hrmsBranchId: { $in: [storeId, storeIdObj] } }
      ];
    }

    if (employeeId) {
      let employeeIdObj = employeeId;
      try {
        const mongoose = require("mongoose");
        if (mongoose.Types.ObjectId.isValid(employeeId)) {
          employeeIdObj = new mongoose.Types.ObjectId(employeeId);
        }
      } catch (e) { }
      query.employeeId = { $in: [employeeId, employeeIdObj] };
    }


    const records = await PayrollRecord.find(query)
      .populate("employeeId", "name employeeCode")
      .populate("storeId", "name")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: records });
  } catch (error) {
    console.error("GET_PAYROLL_RECORDS_ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── PF Records ──────────────────────────────────────────────────────────────
// PF setting = the employee's SalaryStructure (pfApplicable / pfMode / PF amount);
// PF deducted = the "PF (Employee)" line of that month's payroll record.
const pfDeductedOf = (rec) => rec?.deductions?.find((d) => d.label === "PF (Employee)")?.amount || 0;
const pfSettingOf = (structure, salaryAmount = 0) => {
  const configured = structure?.standardDeductions?.find((d) => d.name === "PF (Employee)")?.amount || 0;
  const breakdown = ["basic", "hra", "conveyance", "medicalAllowance", "specialAllowance"]
    .reduce((t, k) => t + (Number(structure?.[k]) || 0), 0);
  return {
    pfApplicable: !!structure?.pfApplicable,
    pfMode: structure?.pfMode || "per_day",
    pfConfigured: Number(configured) || 0, // 0 = pfRate% of Basic
    // Lean read, so no schema default: true only when "Per day" was really
    // chosen — then pfConfigured is a per-day amount (see generatePayroll).
    pfPerDayAmount: structure?.pfMode === "per_day",
    pfRate: Number.isFinite(Number(structure?.pfRate)) ? Number(structure.pfRate) : 12,
    // Same rule as generatePayroll: an empty breakdown means Basic = Base Salary.
    basic: breakdown > 0 ? Number(structure?.basic) || 0 : Number(salaryAmount) || 0,
  };
};

// GET /payroll/pf-records?month=&year=&storeId=   (admin / payroll permission)
// Every PF employee (plus anyone with PF deducted that month), with their PF
// setting and the PF their payroll actually deducted.
exports.getPfRecords = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year) return res.status(400).json({ success: false, message: "month and year are required" });
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const empQuery = { ...tenantFilter };
    if (req.query.storeId) empQuery.hrmsBranchId = req.query.storeId;
    const employees = await User.find(empQuery)
      .select("name employeeCode hrmsBranchId isActive salaryStructureId salaryAmount")
      .populate("salaryStructureId")
      .populate("hrmsBranchId", "name")
      .lean();
    const records = await PayrollRecord.find({ type: "payroll", month, year, employeeId: { $in: employees.map((e) => e._id) } }).lean();
    const recByEmp = new Map(records.map((r) => [String(r.employeeId), r]));

    const rows = employees
      .map((e) => {
        const rec = recByEmp.get(String(e._id));
        return {
          employeeId: e._id,
          name: e.name,
          employeeCode: e.employeeCode || "",
          branch: e.hrmsBranchId?.name || "",
          isActive: e.isActive !== false,
          ...pfSettingOf(e.salaryStructureId, e.salaryAmount),
          payrollGenerated: !!rec,
          payableDays: rec?.payableDays ?? null,
          grossSalary: rec?.grossSalary ?? null,
          pfDeducted: pfDeductedOf(rec),
          paymentStatus: rec ? (rec.paymentStatus || rec.status) : null,
        };
      })
      .filter((r) => r.pfApplicable || r.pfDeducted > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.status(200).json({
      success: true,
      data: rows,
      summary: {
        employees: rows.length,
        fixedMonthly: rows.filter((r) => r.pfApplicable && r.pfMode === "fixed_monthly").length,
        perDay: rows.filter((r) => r.pfApplicable && r.pfMode === "per_day").length,
        payrollPending: rows.filter((r) => !r.payrollGenerated).length,
        totalPfDeducted: rows.reduce((s, r) => s + r.pfDeducted, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /payroll/pf-records/me?year=   — the logged-in employee's own PF, month by month.
exports.getMyPfRecords = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(404).json({ success: false, message: "No HRMS employee record for this login" });
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const me = await User.findById(userId).select("name salaryStructureId salaryAmount").populate("salaryStructureId").lean();
    if (!me) return res.status(404).json({ success: false, message: "Employee not found" });
    const records = await PayrollRecord.find({ type: "payroll", employeeId: userId, year }).sort({ month: 1 }).lean();
    const months = records.map((r) => ({
      month: r.month,
      year: r.year,
      payableDays: r.payableDays,
      grossSalary: r.grossSalary,
      pfDeducted: pfDeductedOf(r),
      paymentStatus: r.paymentStatus || r.status,
    }));
    res.status(200).json({
      success: true,
      data: { name: me.name, ...pfSettingOf(me.salaryStructureId, me.salaryAmount), year, months, totalPfDeducted: months.reduce((s, m) => s + m.pfDeducted, 0) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.approvePayroll = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    let queryId = req.params.id;
    let employeeIdObj = req.params.id;
    try {
      if (mongoose.Types.ObjectId.isValid(req.params.id)) {
        queryId = new mongoose.Types.ObjectId(req.params.id);
        employeeIdObj = new mongoose.Types.ObjectId(req.params.id);
      }
    } catch (e) { }

    const record = await PayrollRecord.findOneAndUpdate(
      {
        $or: [
          { _id: { $in: [req.params.id, queryId] } },
          { employeeId: { $in: [req.params.id, employeeIdObj] } }
        ],
        tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null)
      },
      {
        status: "approved",
        paymentStatus: "Due",
        approvedBy: req.user.userId,
        approvedAt: new Date(),
        paidAt: null
      },
      { returnDocument: "after" }
    );

    if (!record) return res.status(404).json({ success: false, message: "Record not found" });

    res.status(200).json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAsPaid = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    let queryId = req.params.id;
    let employeeIdObj = req.params.id;
    try {
      if (mongoose.Types.ObjectId.isValid(req.params.id)) {
        queryId = new mongoose.Types.ObjectId(req.params.id);
        employeeIdObj = new mongoose.Types.ObjectId(req.params.id);
      }
    } catch (e) { }

    // Advance/loan balances were already reduced at generation — paying the
    // payslip only changes its status.
    const record = await PayrollRecord.findOneAndUpdate(
      {
        $or: [
          { _id: { $in: [req.params.id, queryId] } },
          { employeeId: { $in: [req.params.id, employeeIdObj] } }
        ],
        tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null)
      },
      {
        status: "paid",
        paymentStatus: "Paid",
        paidAt: new Date()
      },
      { returnDocument: "after" }
    );

    if (!record) return res.status(404).json({ success: false, message: "Record not found" });

    res.status(200).json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPayrollSlip = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const owned = await PayrollRecord.findOne({ _id: req.params.payrollId, ...tenantFilter }).select("_id");
    if (!owned) return res.status(404).json({ success: false, message: "Payroll record not found" });

    const { generateSalarySlip } = require("../utils/salarySlipGenerator");
    const slip = await generateSalarySlip(req.params.payrollId, req.query.templateId || null);
    res.status(200).json({ success: true, data: slip });
  } catch (error) {
    console.error("GET_PAYROLL_SLIP_ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Self-service — unlike getPayrollRecords (which trusts a client-supplied
// employeeId), this always scopes to the logged-in employee's own records,
// so a staff member can see their own salary history without being able to
// query anyone else's by changing a query param.
exports.getMyPayrollRecords = async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const { month, year } = req.query;
    const query = { employeeId };
    if (month) query.month = parseInt(month);
    if (year) query.year = parseInt(year);

    const records = await PayrollRecord.find(query)
      .populate("employeeId", "name employeeCode")
      .populate("storeId", "name")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: records });
  } catch (error) {
    console.error("GET_MY_PAYROLL_RECORDS_ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Self-service slip view — same rendering as getPayrollSlip, but verifies
// the requested payroll record actually belongs to the logged-in employee
// first, since generateSalarySlip itself has no ownership concept.
exports.getMyPayrollSlip = async (req, res) => {
  try {
    const employeeId = req.user.userId || req.user.id;
    const record = await PayrollRecord.findById(req.params.payrollId).select("employeeId");
    if (!record || String(record.employeeId) !== String(employeeId)) {
      return res.status(404).json({ success: false, message: "Payroll record not found" });
    }
    const { generateSalarySlip } = require("../utils/salarySlipGenerator");
    const slip = await generateSalarySlip(req.params.payrollId, req.query.templateId || null);
    res.status(200).json({ success: true, data: slip });
  } catch (error) {
    console.error("GET_MY_PAYROLL_SLIP_ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePayrollRecord = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    let queryId = req.params.id;
    let employeeIdObj = req.params.id;
    try {
      if (mongoose.Types.ObjectId.isValid(req.params.id)) {
        queryId = new mongoose.Types.ObjectId(req.params.id);
        employeeIdObj = new mongoose.Types.ObjectId(req.params.id);
      }
    } catch (e) { }

    const record = await PayrollRecord.findOneAndDelete({
      _id: queryId,
      tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null)
    });

    if (!record) return res.status(404).json({ success: false, message: "Record not found" });
    // An unpaid payslip that never happened shouldn't keep its advance/loan
    // deductions — give them back. A paid one's deductions really happened.
    if (record.status !== "paid" && record.paymentStatus !== "Paid") await refundBookedAdvances(record._id);
    res.status(200).json({ success: true, message: "Payroll record deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
