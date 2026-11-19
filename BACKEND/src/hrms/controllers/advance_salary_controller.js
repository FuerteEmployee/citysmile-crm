const AdvanceSalary = require("../models/advance_salary_model");
const User = require("../models/user_model");
const LoanPolicy = require("../models/loan_policy_model");
const { getBranchScope, scopedUserIds, canActOnEmployee } = require("../utils/branchScope");
const { checkNumber, firstError } = require("../utils/fieldRules");

// Amount must be a real number above 0 (no -500, no 0, no "abc"); EMI can't be negative.
const amountError = (body, { requireAmount }) => firstError(
  checkNumber("Amount", body.amount, { positive: true, required: requireAmount }),
  checkNumber("Monthly installment", body.monthlyInstallmentAmount, { min: 0 }),
);

// Admin, or a branch supervisor acting on a staff member of their own branches.
async function canManageEmployee(reqUser, req, employeeId) {
  if (await isAdminUser(reqUser)) return true;
  return !!(await getBranchScope(req)) && (await canActOnEmployee(req, employeeId));
}

// Advance Salary (not Loan) is capped at this % of the employee's fixed monthly
// salary, counting everything still outstanding (Pending + unrepaid Approved).
const ADVANCE_CAP_PERCENT = Number(process.env.ADVANCE_SALARY_CAP_PERCENT) || 100;

/* ── Helper: how much Advance Salary this employee may still take ── */
async function getAdvanceLimit(employeeId, tenantFilter, excludeId = null) {
  const emp = await User.findById(employeeId).select("name salaryAmount salaryStructureId").populate("salaryStructureId");
  if (!emp) return null;

  // "Fixed salary" = Base Salary on the staff form; fall back to the salary
  // structure's monthly total for employees that only have a breakdown filled.
  const s = emp.salaryStructureId;
  const structureTotal = s
    ? (Number(s.basic) || 0) + (Number(s.hra) || 0) + (Number(s.conveyance) || 0) +
      (Number(s.medicalAllowance) || 0) + (Number(s.specialAllowance) || 0)
    : 0;
  const fixedSalary = Number(emp.salaryAmount) || structureTotal;
  const maxAllowed = Math.floor((fixedSalary * ADVANCE_CAP_PERCENT) / 100);

  const outstandingQuery = {
    employeeId: emp._id,
    type: "Advance Salary",
    status: { $in: ["Pending", "Approved"] },
    ...tenantFilter,
  };
  if (excludeId) outstandingQuery._id = { $ne: excludeId };
  const open = await AdvanceSalary.find(outstandingQuery).select("status amount remainingAmount");
  const outstanding = open.reduce(
    (sum, a) => sum + (a.status === "Approved" ? Number(a.remainingAmount ?? a.amount) || 0 : Number(a.amount) || 0),
    0
  );

  return {
    employeeName: emp.name,
    fixedSalary,
    capPercent: ADVANCE_CAP_PERCENT,
    maxAllowed,
    outstanding,
    available: Math.max(0, maxAllowed - outstanding),
  };
}

// Returns an error message if `amount` would exceed the employee's limit, else null.
async function checkAdvanceLimit(employeeId, amount, tenantFilter, excludeId = null) {
  const limit = await getAdvanceLimit(employeeId, tenantFilter, excludeId);
  if (!limit) return "Employee not found";
  if (limit.fixedSalary <= 0) {
    return "Set this employee's fixed salary before requesting an advance";
  }
  if (Number(amount) > limit.available) {
    return `Advance exceeds the limit: max ₹${limit.maxAllowed.toLocaleString("en-IN")} (${limit.capPercent}% of fixed salary), ` +
      `₹${limit.outstanding.toLocaleString("en-IN")} already outstanding, ₹${limit.available.toLocaleString("en-IN")} available`;
  }
  return null;
}

/* ── Loan limit by salary slab (LoanPolicy) ──
 * A saved slab covering the employee's salary sets the max loan; otherwise
 * (no slabs saved, or none matches) the default is salary × LOAN_SALARY_MULTIPLE
 * — so a loan is never unlimited. e.g. ₹25,000 × 10 = ₹2,50,000.
 * Counts everything still outstanding (Pending + unrepaid Approved loans). */
const fmtINR = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const LOAN_SALARY_MULTIPLE = Number(process.env.LOAN_SALARY_MULTIPLE) || 10;

async function getLoanLimit(employeeId, tenantFilter, excludeId = null) {
  const emp = await User.findById(employeeId).select("name salaryAmount salaryStructureId").populate("salaryStructureId");
  if (!emp) return null;
  const s = emp.salaryStructureId;
  const structureTotal = s
    ? (Number(s.basic) || 0) + (Number(s.hra) || 0) + (Number(s.conveyance) || 0) +
      (Number(s.medicalAllowance) || 0) + (Number(s.specialAllowance) || 0)
    : 0;
  const fixedSalary = Number(emp.salaryAmount) || structureTotal;

  const policy = await LoanPolicy.findOne({ tenant_id: tenantFilter.tenant_id ?? null }).lean();
  const slabs = policy?.slabs || [];
  const slab = slabs.find((sl) => fixedSalary >= sl.minSalary && (sl.maxSalary == null || fixedSalary <= sl.maxSalary)) || null;

  const outstandingQuery = { employeeId: emp._id, type: "Loan", status: { $in: ["Pending", "Approved"] }, ...tenantFilter };
  if (excludeId) outstandingQuery._id = { $ne: excludeId };
  const open = await AdvanceSalary.find(outstandingQuery).select("status amount remainingAmount");
  const outstanding = open.reduce(
    (sum, a) => sum + (a.status === "Approved" ? Number(a.remainingAmount ?? a.amount) || 0 : Number(a.amount) || 0),
    0
  );

  const maxAllowed = slab ? slab.maxLoan : Math.floor(fixedSalary * LOAN_SALARY_MULTIPLE);
  return {
    employeeName: emp.name,
    fixedSalary,
    configured: true, // a limit always applies (slab or salary multiple)
    slab: slab ? { minSalary: slab.minSalary, maxSalary: slab.maxSalary, maxLoan: slab.maxLoan } : null,
    multiple: slab ? null : LOAN_SALARY_MULTIPLE,
    maxAllowed,
    outstanding,
    available: Math.max(0, maxAllowed - outstanding),
  };
}

// Returns an error message if a loan of `amount` isn't allowed, else null.
async function checkLoanLimit(employeeId, amount, tenantFilter, excludeId = null) {
  const limit = await getLoanLimit(employeeId, tenantFilter, excludeId);
  if (!limit) return "Employee not found";
  if (limit.fixedSalary <= 0) return "Set this employee's fixed salary before requesting a loan";
  if (Number(amount) > limit.available) {
    return `Loan exceeds the limit: max ${fmtINR(limit.maxAllowed)} for a salary of ${fmtINR(limit.fixedSalary)}` +
      (limit.outstanding > 0 ? `, ${fmtINR(limit.outstanding)} already outstanding, ${fmtINR(limit.available)} available` : "");
  }
  return null;
}

/* ── Helper: check if the requesting user is an admin-level role ── */
async function isAdminUser(reqUser) {
  // A Staff-bridged token (see hrms/middleware/auth_middleware.js's protect)
  // carries the tenant admin/owner flag directly — the linked HRMS User
  // record it resolves to was never guaranteed to have a `role` set (e.g. a
  // tenant owner backfilled without one), so relying on that role lookup
  // alone silently failed the admin check for real tenant admins.
  if (reqUser?.admin || reqUser?.is_superadmin) return true;
  try {
    const user = await User.findById(reqUser.userId).populate("role");
    if (!user) return false;
    const roleName =
      user.role && typeof user.role === "object"
        ? user.role.role
        : String(user.role || "");
    return ["admin", "super_admin", "owner", "manager"].includes(
      roleName.toLowerCase()
    );
  } catch {
    return false;
  }
}

// POST /api/advance-salary
exports.createAdvanceSalary = async (req, res) => {
  try {
    const invalid = amountError(req.body, { requireAmount: true });
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const loggedInId = req.user.userId || req.user.id;

    // Force employeeId to the logged-in user unless an admin (or the employee's
    // branch supervisor) is raising it on someone else's behalf.
    const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(loggedInId)
      && (await canManageEmployee(req.user, req, req.body.employeeId));
    const employeeId = onBehalf ? req.body.employeeId : loggedInId;

    // Determine initial status based on role
    // If the creator is an owner or super_admin, auto-approve the request
    let status = "Pending";
    if (req.user) {
      const userDoc = await User.findById(req.user.userId).populate("role");
      if (userDoc) {
        const roleName = userDoc.role && typeof userDoc.role === "object"
          ? userDoc.role.role
          : String(userDoc.role || "");
        if (["super_admin", "owner"].includes(roleName.toLowerCase())) {
          status = "Approved";
        }
      }
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    if ((req.body.type || "Advance Salary") === "Advance Salary") {
      const limitError = await checkAdvanceLimit(employeeId, req.body.amount, tenantFilter);
      if (limitError) return res.status(400).json({ success: false, message: limitError });
    } else if (req.body.type === "Loan") {
      const limitError = await checkLoanLimit(employeeId, req.body.amount, tenantFilter);
      if (limitError) return res.status(400).json({ success: false, message: limitError });
    }

    const record = new AdvanceSalary({
      ...req.body,
      employeeId,
      status,
      requestDate: req.body.requestDate || new Date(),
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });

    await record.save();
    await record.populate("employeeId", "name email");
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/advance-salary
exports.getAdvanceSalaries = async (req, res) => {
  try {
    const loggedInId = req.user.userId || req.user.id;
    const admin = await isAdminUser(req.user);

    const { status, type, storeId } = req.query;
    // "me" = the logged-in employee's own records (used by the profile pages).
    const employeeId = req.query.employeeId === "me" ? String(loggedInId) : req.query.employeeId;
    const query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const supervisedIds = admin ? null : await scopedUserIds(req);
    if (admin) {
      // Admin sees everything — optional filters
      if (employeeId) query.employeeId = employeeId;
      if (storeId)    query.storeId = storeId;
    } else if (supervisedIds) {
      // Branch supervisor: their branches' staff (+ their own requests)
      query.employeeId = employeeId && supervisedIds.some((id) => String(id) === String(employeeId))
        ? employeeId
        : { $in: supervisedIds };
    } else {
      // Employee sees ONLY their own records
      query.employeeId = loggedInId;
    }

    if (status) query.status = status;
    if (type)   query.type = type;

    const records = await AdvanceSalary.find(query)
      .sort({ requestDate: -1 })
      .populate("employeeId", "name email")
      .populate("approvedBy", "name email");

    res.status(200).json({ success: true, count: records.length, data: records });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/advance-salary/limit/:employeeId  ("me" = the logged-in employee)
exports.getAdvanceLimit = async (req, res) => {
  try {
    const loggedInId = req.user.userId || req.user.id;
    const admin = await isAdminUser(req.user);
    const requested = req.params.employeeId === "me" ? loggedInId : req.params.employeeId;
    // Non-admins can only look up their own limit (supervisors: their branches' staff too).
    const employeeId = admin || (await canManageEmployee(req.user, req, requested)) ? requested : loggedInId;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const limit = await getAdvanceLimit(employeeId, tenantFilter);
    if (!limit) return res.status(404).json({ success: false, message: "Employee not found" });
    res.status(200).json({ success: true, data: limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/advance-salary/loan-limit/:employeeId  ("me" = the logged-in employee)
exports.getLoanLimit = async (req, res) => {
  try {
    const loggedInId = req.user.userId || req.user.id;
    const admin = await isAdminUser(req.user);
    const requested = req.params.employeeId === "me" ? loggedInId : req.params.employeeId;
    const employeeId = admin || (await canManageEmployee(req.user, req, requested)) ? requested : loggedInId;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const limit = await getLoanLimit(employeeId, tenantFilter);
    if (!limit) return res.status(404).json({ success: false, message: "Employee not found" });
    res.status(200).json({ success: true, data: limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/advance-salary/loan-policy — the company's salary slabs (anyone may read)
exports.getLoanPolicy = async (req, res) => {
  try {
    const tenant_id = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);
    const policy = await LoanPolicy.findOne({ tenant_id }).lean();
    res.status(200).json({ success: true, data: { slabs: policy?.slabs || [] } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/advance-salary/loan-policy  { slabs: [{ minSalary, maxSalary|null, maxLoan }] } — admins only
exports.updateLoanPolicy = async (req, res) => {
  try {
    if (!(await isAdminUser(req.user))) {
      return res.status(403).json({ success: false, message: "Only admins can change loan limits" });
    }
    const raw = Array.isArray(req.body?.slabs) ? req.body.slabs : [];
    const slabs = raw.map((s) => ({
      minSalary: Number(s.minSalary),
      maxSalary: s.maxSalary === null || s.maxSalary === "" || s.maxSalary === undefined ? null : Number(s.maxSalary),
      maxLoan: Number(s.maxLoan),
    })).sort((a, b) => a.minSalary - b.minSalary);

    for (let i = 0; i < slabs.length; i++) {
      const s = slabs[i];
      const row = `Slab ${fmtINR(s.minSalary)}${s.maxSalary == null ? "+" : `–${fmtINR(s.maxSalary)}`}`;
      if (!Number.isFinite(s.minSalary) || s.minSalary < 0) return res.status(400).json({ success: false, message: "Salary 'from' must be ₹0 or more" });
      if (s.maxSalary != null && (!Number.isFinite(s.maxSalary) || s.maxSalary < s.minSalary)) return res.status(400).json({ success: false, message: `${row}: salary 'to' must be at least 'from'` });
      if (!Number.isFinite(s.maxLoan) || s.maxLoan <= 0) return res.status(400).json({ success: false, message: `${row}: max loan must be more than ₹0` });
      const next = slabs[i + 1];
      // Touching ranges (20,000–35,000 then 35,000–…) are fine — a salary of
      // exactly 35,000 uses the first slab. Only a real overlap is rejected.
      if (next && (s.maxSalary == null || next.minSalary < s.maxSalary)) {
        return res.status(400).json({ success: false, message: `${row} overlaps the next slab — salary ranges can't overlap` });
      }
    }

    const tenant_id = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);
    const policy = await LoanPolicy.findOneAndUpdate(
      { tenant_id },
      { slabs, updatedBy: req.user.userId || req.user.id || null },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.status(200).json({ success: true, data: { slabs: policy.slabs } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/advance-salary/:id
exports.getAdvanceSalaryById = async (req, res) => {
  try {
    const loggedInId = req.user.userId || req.user.id;
    const admin = await isAdminUser(req.user);

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await AdvanceSalary.findOne({ _id: req.params.id, ...tenantFilter })
      .populate("employeeId", "name email")
      .populate("approvedBy", "name email");

    if (!record)
      return res.status(404).json({ success: false, message: "Record not found" });

    // Employees can only view their own record (supervisors: their branches' staff too)
    const recordEmp = record.employeeId?._id || record.employeeId;
    if (!admin && String(recordEmp) !== String(loggedInId) && !(await canManageEmployee(req.user, req, recordEmp))) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    res.status(200).json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/advance-salary/:id  (approve / reject / mark repaid)
exports.updateAdvanceSalary = async (req, res) => {
  try {
    const invalid = amountError(req.body, { requireAmount: false });
    if (invalid) return res.status(400).json({ success: false, message: invalid });
    const loggedInId = req.user.userId || req.user.id;
    const update = { ...req.body };
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    // Needed regardless of admin/non-admin path: the approval branch below
    // reads type/amount to seed remainingAmount, and non-admins are checked
    // against employeeId — one fetch covers both.
    const existing = await AdvanceSalary.findOne({ _id: req.params.id, ...tenantFilter }).select("employeeId status type amount remainingAmount");
    if (!existing) {
      return res.status(404).json({ success: false, message: "Record not found" });
    }

    // "admin" here = may manage this employee's request: a tenant admin, or the
    // employee's branch supervisor (never for the supervisor's own request).
    const admin = await canManageEmployee(req.user, req, existing.employeeId);

    // Non-admins may only touch their OWN request. Without this an employee
    // could edit the amount or reason on someone else's advance.
    if (!admin && String(existing.employeeId) !== String(loggedInId)) {
      return res.status(403).json({ success: false, message: "Not authorized to modify this request" });
    }

    // Only admins may move the status at all — this used to allow "Repaid"
    // through, letting an employee mark their own outstanding advance as
    // repaid and wipe the recovery.
    if (!admin && update.status !== undefined) {
      return res.status(403).json({ success: false, message: "Only admins can change the status of a request" });
    }

    // Track approver
    if (update.status === "Approved" || update.status === "Rejected") {
      update.approvedBy = loggedInId;
    }

    // Installment plans only ever apply to "Loan" — an "Advance Salary" always
    // deducts in full on the next payroll run, regardless of what the client sends.
    if (existing.type !== "Loan") {
      update.monthlyInstallmentAmount = 0;
    } else {
      // The monthly salary deduction (EMI) is the admin's decision — an
      // employee editing their own request must not be able to set ₹1/month.
      if (!admin) delete update.monthlyInstallmentAmount;
      const loanAmount = update.amount !== undefined ? Number(update.amount) : Number(existing.amount) || 0;
      const emiGiven = update.monthlyInstallmentAmount !== undefined;
      const emi = Number(update.monthlyInstallmentAmount);
      // Approving a loan requires the fixed monthly deduction — without it
      // payroll would take the whole loan out of one salary.
      if (update.status === "Approved" && !(emi > 0)) {
        return res.status(400).json({ success: false, message: "Set the fixed monthly salary deduction (EMI) to approve this loan" });
      }
      if (emiGiven && (!(emi > 0) || emi > loanAmount)) {
        return res.status(400).json({ success: false, message: `Monthly deduction must be between ₹1 and ₹${loanAmount.toLocaleString("en-IN")}` });
      }
      if (emiGiven) update.monthlyInstallmentAmount = Math.round(emi);
    }

    // Balance + repayment history are server-managed (payroll runs and
    // POST /:id/repay) — never taken from the client. Previously an employee
    // editing their own request could send remainingAmount: 0.
    delete update.remainingAmount;
    delete update.installments;
    delete update.repaidInPayrollRecordId;

    // "Mark fully repaid" = a manual repayment of whatever is still outstanding,
    // so the balance and history stay consistent with the status.
    if (update.status === "Repaid") {
      if (existing.status !== "Approved") {
        return res.status(400).json({ success: false, message: "Only an approved advance/loan can be marked repaid" });
      }
      const outstanding = Number(existing.remainingAmount ?? existing.amount) || 0;
      update.remainingAmount = 0;
      if (outstanding > 0) {
        const now = new Date();
        update.$push = { installments: { month: now.getMonth() + 1, year: now.getFullYear(), amount: outstanding, source: "manual", note: update.repaymentNote || "Marked fully repaid", recordedBy: loggedInId, deductedAt: now } };
      }
      delete update.repaymentNote;
    }

    // Re-check the fixed-salary cap when the amount changes or on approval —
    // the salary or other advances may have changed since the request was made.
    const newAmount = update.amount !== undefined ? Number(update.amount) : existing.amount;
    if (existing.type === "Advance Salary" && (update.amount !== undefined || update.status === "Approved")) {
      const limitError = await checkAdvanceLimit(existing.employeeId, newAmount, tenantFilter, existing._id);
      if (limitError) return res.status(400).json({ success: false, message: limitError });
    }
    // Same for loans against the salary-slab limit — a loan requested before
    // the limits were set (or before a salary change) can't be approved over it.
    if (existing.type === "Loan" && (update.amount !== undefined || update.status === "Approved")) {
      const limitError = await checkLoanLimit(existing.employeeId, newAmount, tenantFilter, existing._id);
      if (limitError) return res.status(400).json({ success: false, message: limitError });
    }

    // Seed the outstanding balance the moment a request is approved — payroll
    // deducts against remainingAmount, never against the original `amount`.
    if (update.status === "Approved") {
      update.remainingAmount = newAmount;
    }

    const record = await AdvanceSalary.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      update,
      { new: true, runValidators: true }
    )
      .populate("employeeId", "name email")
      .populate("approvedBy", "name email");

    if (!record)
      return res.status(404).json({ success: false, message: "Record not found" });

    res.status(200).json({ success: true, data: record });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/advance-salary/:id/repay  { amount, note? }
// Record a (partial or full) repayment outside payroll — e.g. the employee paid
// back half in cash. Reduces the balance; reaching 0 marks the record Repaid.
exports.recordRepayment = async (req, res) => {
  try {
    const loggedInId = req.user.userId || req.user.id;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await AdvanceSalary.findOne({ _id: req.params.id, ...tenantFilter });
    if (!record) return res.status(404).json({ success: false, message: "Record not found" });

    if (!(await canManageEmployee(req.user, req, record.employeeId))) {
      return res.status(403).json({ success: false, message: "Only an admin (or the employee's branch supervisor) can record a repayment" });
    }
    if (record.status !== "Approved") {
      return res.status(400).json({ success: false, message: `Repayments can only be recorded on an approved ${record.type.toLowerCase()} (this one is ${record.status})` });
    }

    const outstanding = Number(record.remainingAmount ?? record.amount) || 0;
    const amount = Math.round(Number(req.body.amount) * 100) / 100;
    if (!(amount > 0)) {
      return res.status(400).json({ success: false, message: "Enter a repayment amount greater than 0" });
    }
    if (amount > outstanding) {
      return res.status(400).json({ success: false, message: `Amount is more than the outstanding balance (₹${outstanding.toLocaleString("en-IN")})` });
    }

    const now = new Date();
    record.installments.push({
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      amount,
      source: "manual",
      note: String(req.body.note || "").slice(0, 200),
      recordedBy: loggedInId,
      deductedAt: now,
    });
    record.remainingAmount = Math.max(0, Math.round((outstanding - amount) * 100) / 100);
    if (record.remainingAmount <= 0) record.status = "Repaid";
    await record.save();
    await record.populate("employeeId", "name email");
    await record.populate("approvedBy", "name email");

    res.status(200).json({
      success: true,
      message: record.status === "Repaid"
        ? `Fully repaid — ${record.type} closed`
        : `₹${amount.toLocaleString("en-IN")} recorded, ₹${record.remainingAmount.toLocaleString("en-IN")} still outstanding`,
      data: record,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/advance-salary/:id  (super admin / owner only)
exports.deleteAdvanceSalary = async (req, res) => {
  try {
    // Server-side authorization: only super_admin / owner may delete a record.
    // A Staff-bridged token carries the tenant admin/owner flag directly (see
    // isAdminUser above) — the linked HRMS User's role was never guaranteed
    // to be set, so that lookup alone silently blocked real tenant owners too.
    let authorized = !!(req.user?.admin || req.user?.is_superadmin);
    if (!authorized) {
      const user = await User.findById(req.user.userId).populate("role");
      const roleName =
        user && user.role && typeof user.role === "object"
          ? user.role.role
          : String((user && user.role) || "");
      authorized = ["super_admin", "owner"].includes(roleName.toLowerCase());
    }
    if (!authorized) {
      return res.status(403).json({ success: false, message: "Not authorized to delete advance/loan records" });
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await AdvanceSalary.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!record)
      return res.status(404).json({ success: false, message: "Record not found" });
    res.status(200).json({ success: true, message: "Record deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
