const PayrollRecord = require("../models/payroll_record_model");
const SalaryTemplate = require("../models/salary_template_model");
const User = require("../models/user_model");
const Attendance = require("../models/attendance_model");
const LeaveBalance = require("../models/leave_balance_model");

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─── HTML Template Renderer ───────────────────────────────────────────────────

function INR(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN");
}

function renderHtmlTemplate(htmlTemplate, slip) {
  const earningsRows = (slip.earnings || []).map(e =>
    `<tr>
      <td style="padding:4px 10px;border:1px solid #e2e8f0;color:#374151;">${e.label}</td>
      <td style="text-align:right;padding:4px 10px;border:1px solid #e2e8f0;color:#1e293b;font-weight:500;">${INR(e.amount)}</td>
    </tr>`
  ).join("") || `<tr><td colspan="2" style="text-align:center;padding:8px;color:#94a3b8;font-style:italic;">No earnings</td></tr>`;

  const deductionsRows = (slip.deductions || []).map(d =>
    `<tr>
      <td style="padding:4px 10px;border:1px solid #fecaca;color:#374151;">${d.label}</td>
      <td style="text-align:right;padding:4px 10px;border:1px solid #fecaca;color:#dc2626;font-weight:500;">${INR(d.amount)}</td>
    </tr>`
  ).join("") || `<tr><td colspan="2" style="text-align:center;padding:8px;color:#94a3b8;font-style:italic;">No deductions</td></tr>`;

  const leaveRows = (slip.leaveBalances || []).map(l =>
    `<tr>
      <td style="padding:5px 8px;border:1px solid #ddd6fe;color:#374151;">${l.type}</td>
      <td style="text-align:center;padding:5px 8px;border:1px solid #ddd6fe;color:#475569;">${l.entitled}</td>
      <td style="text-align:center;padding:5px 8px;border:1px solid #ddd6fe;color:#dc2626;">${l.taken}</td>
      <td style="text-align:center;padding:5px 8px;border:1px solid #ddd6fe;font-weight:700;color:#7c3aed;">${l.balance}</td>
    </tr>`
  ).join("") || `<tr><td colspan="4" style="text-align:center;padding:8px;color:#94a3b8;font-style:italic;">No leave data</td></tr>`;

  const tokens = {
    employeeName:     slip.employeeName     || "",
    employeeId:       slip.employeeId       || "",
    designation:      slip.designation      || "",
    department:       slip.department       || "",
    dateOfJoining:    slip.dateOfJoining    || "",
    payPeriod:        slip.payPeriod        || "",
    payDate:          slip.payDate          || "",
    panNumber:        slip.panNumber        || "",
    uanNumber:        slip.uanNumber        || "",
    monthName:        slip.payPeriod        || "",
    totalDays:        String(slip.totalDays    || 0),
    presentDays:      String(slip.presentDays  || 0),
    absentDays:       String(slip.absentDays   || 0),
    leaveDays:        String(slip.leaveDays    || 0),
    lopDays:          String(slip.lopDays      || 0),
    overtimeHours:    String(slip.overtimeHours|| 0),
    grossSalary:      INR(slip.grossSalary),
    totalEarnings:    INR(slip.totalEarnings),
    totalDeductions:  INR(slip.totalDeductions),
    netPay:           INR(slip.netPay),
    bankName:         slip.bankName         || "",
    accountNumber:    slip.accountNumber    || "",
    ifscCode:         slip.ifscCode         || "",
    paymentMode:      slip.paymentMode      || "",
    COMPANY_NAME:     slip.template?.companyName    || "",
    COMPANY_ADDRESS:  slip.template?.companyAddress || "",
    COMPANY_LOGO:     slip.template?.companyLogoUrl
      ? `<img src="${slip.template.companyLogoUrl}" style="width:48px;height:48px;object-fit:contain;border-radius:8px;" />`
      : "",
    EARNINGS_ROWS:    earningsRows,
    DEDUCTIONS_ROWS:  deductionsRows,
    LEAVE_ROWS:       leaveRows,
  };

  return htmlTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    tokens[key] !== undefined ? String(tokens[key]) : `{{${key}}}`
  );
}

function replacePlaceholders(str, ctx) {
  if (!str) return "";
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] ?? "");
}

function fmt(date, opts) {
  try {
    return new Date(date).toLocaleDateString("en-IN", opts || {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return "—";
  }
}

async function generateSalarySlip(payrollId, templateId) {
  const payroll = await PayrollRecord.findById(payrollId)
    .populate({
      path: "employeeId",
      select: "name employeeCode designation department joiningDate bankInfo legalDocuments storeId",
      populate: [
        { path: "designation", select: "name" },
        { path: "department", select: "name" },
      ],
    })
    .populate("storeId", "name address");

  if (!payroll) throw new Error("Payroll record not found");

  const employee = payroll.employeeId;
  if (!employee) throw new Error("Employee data not found on payroll record");

  // Resolve template
  let template = null;
  if (templateId) {
    template = await SalaryTemplate.findById(templateId);
    if (!template) throw new Error("Specified template not found");
  } else {
    template = await SalaryTemplate.findOne({ isDefault: true });
  }

  // Attendance summary for the pay month
  const lastDay = new Date(payroll.year, payroll.month, 0).getDate();
  const monthPad = String(payroll.month).padStart(2, "0");
  const startStr = `${payroll.year}-${monthPad}-01`;
  const endStr = `${payroll.year}-${monthPad}-${String(lastDay).padStart(2, "0")}`;

  const attendanceRecords = await Attendance.find({
    userId: employee._id,
    date: { $gte: startStr, $lte: endStr },
  });

  const totalDays = lastDay;
  const presentDays = payroll.presentDays || 0;
  const lopDays = payroll.unpaidLeaveDays || 0;
  const leaveDays = payroll.leaveDays || 0;
  // Stored by payroll since the weekly-off fix; the old subtraction actually
  // gave the unworked paid Sundays, so it's only a fallback for old records.
  const absentDays = payroll.absentDays != null
    ? payroll.absentDays
    : Math.max(0, totalDays - presentDays - leaveDays - lopDays);
  const overtimeHours = Math.round((payroll.overtimeMinutes || 0) / 60);

  // Leave balances
  let leaveBalances = [];
  try {
    const balances = await LeaveBalance.find({
      employeeId: employee._id,
      year: payroll.year,
    }).populate("leaveTypeId", "name");

    leaveBalances = balances.map((b) => ({
      type: b.leaveTypeId?.name || "Leave",
      entitled: (b.totalAllocated || 0) + (b.carriedForward || 0),
      taken: b.used || 0,
      balance: Math.max(0, (b.totalAllocated || 0) + (b.carriedForward || 0) - (b.used || 0) - (b.pending || 0)),
    }));
  } catch (_) {}

  // Earnings
  const snap = payroll.salaryStructureSnapshot || {};
  const additions = payroll.additions || [];

  const earnings = [
    { label: "Basic Pay", amount: snap.basic || 0 },
    { label: "HRA", amount: snap.hra || 0 },
    { label: "Transport Allowance", amount: snap.conveyance || 0 },
    { label: "Medical Allowance", amount: snap.medicalAllowance || 0 },
    { label: "Special Allowance", amount: snap.specialAllowance || 0 },
    ...additions.map((a) => ({ label: a.label, amount: Number(a.amount) || 0 })),
  ].filter((e) => e.amount > 0);

  const totalEarnings = earnings.reduce((s, e) => s + e.amount, 0);

  // Deductions
  const deductions = (payroll.deductions || []).map((d) => ({
    label: d.label,
    amount: Number(d.amount) || 0,
  }));

  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
  const netPay = payroll.netSalary ?? totalEarnings - totalDeductions;

  // Placeholder context for branding tokens
  const placeholderCtx = {
    companyName: template?.companyName || payroll.storeId?.name || "",
    companyAddress: template?.companyAddress || payroll.storeId?.address || "",
  };

  const companyName = replacePlaceholders(
    template?.companyName || payroll.storeId?.name || "",
    placeholderCtx
  );
  const companyAddress = replacePlaceholders(
    template?.companyAddress || payroll.storeId?.address || "",
    placeholderCtx
  );

  const slipResult = {
    // Template branding
    template: template
      ? {
          _id: template._id,
          name: template.name,
          companyName,
          companyAddress,
          companyLogoUrl: template.companyLogoUrl,
          headerColor: template.headerColor,
          accentColor: template.accentColor,
          sections: template.sections,
          customFields: template.customFields,
          footerNote: replacePlaceholders(template.footerNote, placeholderCtx),
          // Canvas fields
          canvasWidth: template.canvasWidth,
          canvasHeight: template.canvasHeight,
          canvasBg: template.canvasBg,
          bgImage: template.bgImage,
          bgOpacity: template.bgOpacity,
          elements: template.elements,
        }
      : null,

    // Employee info
    employeeName: employee.name,
    employeeId: employee.employeeCode || String(employee._id).slice(-6).toUpperCase(),
    designation: employee.designation?.name || "—",
    department: employee.department?.name || "—",
    dateOfJoining: employee.joiningDate ? fmt(employee.joiningDate) : "—",
    panNumber: employee.legalDocuments?.panNumber || "—",
    uanNumber: employee.legalDocuments?.uanNumber || "—",

    // Pay period
    payPeriod: `${MONTH_NAMES[payroll.month - 1]} ${payroll.year}`,
    payDate: payroll.paidAt ? fmt(payroll.paidAt) : fmt(new Date()),

    // Attendance
    totalDays,
    presentDays,
    absentDays,
    leaveDays,
    lopDays,
    overtimeHours,

    // Leave balances
    leaveBalances,

    // Earnings
    earnings,
    totalEarnings,

    // Deductions
    deductions,
    totalDeductions,

    // Totals
    grossSalary: payroll.grossSalary || totalEarnings,
    netPay,

    // Bank
    bankName: employee.bankInfo?.bankName || "—",
    accountNumber: employee.bankInfo?.accountNumber || "—",
    ifscCode: employee.bankInfo?.ifscCode || "—",
    paymentMode: "Bank Transfer",
  };

  // Render stored HTML template with real data if available
  if (template?.htmlTemplate) {
    slipResult.renderedHtml = renderHtmlTemplate(template.htmlTemplate, slipResult);
  }

  return slipResult;
}

module.exports = { generateSalarySlip };
