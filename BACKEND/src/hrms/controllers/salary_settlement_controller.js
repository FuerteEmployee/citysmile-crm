const SalarySettlementRecord = require("../models/salary_settlement_record_model");
const SalespersonTarget = require("../models/salesperson_target_model");
const User = require("../models/user_model");
const ManagingCompany = require("../models/managing_company_model");
const { resolveSalespersonId, getAchievedRevenue } = require("../utils/sales_achievement");

/**
 * Helper: Round to nearest rupee
 */
const roundToRupee = (val) => {
  if (val === null || val === undefined) return null;
  return Math.round(val);
};

/**
 * Calculate settlement estimate for an employee/month
 * Computes achieved revenue from sales invoices, applies formula,
 * upserts a SalarySettlementRecord in pending_slip status
 *
 * Guards enforced:
 * - G1: No target → flag noTargetSet, leave computedActualSalary null
 * - G4: Multi-branch invoices → flag branchScopeMismatch
 * - G5: Employee→Salesperson resolution with fallback
 */
exports.calculateEstimate = async (req, res) => {
  try {
    const { employeeId, month, year } = req.body;

    if (!employeeId || !month || !year) {
      return res.status(400).json({
        success: false,
        message: "employeeId, month, and year are required",
      });
    }

    // Fetch employee — same company only
    const employeeQuery = { _id: employeeId };
    if (!req.user?.is_superadmin) employeeQuery.tenant_id = req.user?.tenant_id || null;
    const employee = await User.findOne(employeeQuery);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // G5: Resolve salesperson ID
    const salespersonId = await resolveSalespersonId(employeeId);

    // Fetch managing company
    const managingCompanyId = employee.managingCompanyId;
    if (!managingCompanyId) {
      return res.status(400).json({
        success: false,
        message: "Employee does not have a managing company assigned",
      });
    }

    const managingCompany = await ManagingCompany.findById(managingCompanyId);
    if (!managingCompany) {
      return res.status(404).json({
        success: false,
        message: "Managing company not found",
      });
    }

    // Snapshot decided salary — a 0/unset decided salary makes reconciliation
    // meaningless (the entire brand slip would read as surplus), so block it.
    const decidedSalary = employee.salaryAmount;
    if (!decidedSalary || decidedSalary <= 0) {
      return res.status(400).json({
        success: false,
        message: `${employee.name || "Employee"} has no decided salary set. Set their Salary Amount on the staff form before adding them to settlement.`,
      });
    }

    // Fetch target for this employee/month
    const target = await SalespersonTarget.findOne({
      salespersonId,
      month,
      year,
    });

    let targetAmount = null;
    let achievedRevenue = null;
    let computedActualSalary = null;
    const flags = { noTargetSet: false, branchScopeMismatch: false };

    // G1: If target exists, compute achieved revenue and estimate
    if (target && target.targetAmount > 0) {
      targetAmount = target.targetAmount;

      if (salespersonId) {
        const { revenueAchieved, branchesInvolved } = await getAchievedRevenue(
          salespersonId,
          month,
          year
        );
        achievedRevenue = revenueAchieved;

        // G4: Check for branch-scope mismatch
        if (branchesInvolved.length > 1) {
          flags.branchScopeMismatch = true;
        }

        // Compute estimated salary: decidedSalary * (achievedRevenue / targetAmount)
        if (targetAmount > 0) {
          computedActualSalary = roundToRupee(
            decidedSalary * (achievedRevenue / targetAmount)
          );
          // Clamp to >= 0
          if (computedActualSalary < 0) {
            computedActualSalary = 0;
          }
        }
      }
    } else {
      // G1: No target set
      flags.noTargetSet = true;
    }

    const tenant_id = req.user?.is_superadmin ? null : (req.user?.tenant_id || null);

    // Upsert settlement record (G2-safe: filter out settled records)
    const result = await SalarySettlementRecord.findOneAndUpdate(
      {
        employeeId,
        month,
        year,
        status: { $ne: "settled" }, // ← G2: don't overwrite settled records
      },
      {
        $set: {
          employeeId,
          salespersonId: salespersonId || null,
          managingCompanyId,
          month,
          year,
          decidedSalary,
          targetAmount,
          achievedRevenue,
          computedActualSalary,
          flags,
          status: "pending_slip",
          tenant_id,
        },
      },
      { upsert: true, new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: "Settlement estimate calculated",
      data: result,
    });
  } catch (error) {
    // Handle unique index conflict (settled record exists, can't overwrite)
    if (error.code === 11000 && error.keyPattern?.employeeId) {
      return res.status(409).json({
        success: false,
        message:
          "Settlement record already settled and immutable. Cannot recalculate.",
      });
    }

    res.status(400).json({
      success: false,
      message: error.message || "Failed to calculate settlement estimate",
    });
  }
};

/**
 * Set the brand slip amount (authoritative) and compute variance/settlement
 * Moves status from pending_slip → pending_settlement
 * Blocked if record is already settled (G2)
 */
exports.setBrandSlipAmount = async (req, res) => {
  try {
    const { id, brandSlipAmount } = req.body;

    if (
      brandSlipAmount === null ||
      brandSlipAmount === undefined ||
      typeof brandSlipAmount !== "number" ||
      isNaN(brandSlipAmount) ||
      brandSlipAmount < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "brandSlipAmount must be a non-negative number",
      });
    }

    // Fetch existing record
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await SalarySettlementRecord.findOne({ _id: id, ...tenantFilter });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Settlement record not found",
      });
    }

    // G2: Reject if already settled
    if (record.status === "settled") {
      return res.status(409).json({
        success: false,
        message: "Record already settled and immutable. Cannot update.",
      });
    }

    // Compute variance and settlement (G3: round to rupee)
    const variance = roundToRupee(brandSlipAmount - record.decidedSalary);
    const settlementAmount = variance !== null ? roundToRupee(Math.abs(variance)) : null;

    let direction = "none";
    if (variance > 0) {
      direction = "employee_to_ge"; // Employee pays GE the surplus
    } else if (variance < 0) {
      direction = "ge_to_employee"; // GE pays employee the shortfall
    }

    // Update record
    record.brandSlipAmount = brandSlipAmount;
    record.variance = variance;
    record.settlementAmount = settlementAmount;
    record.direction = direction;
    record.status = "pending_settlement";
    await record.save();

    res.status(200).json({
      success: true,
      message: "Brand slip amount set, variance computed",
      data: record,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to set brand slip amount",
    });
  }
};

/**
 * Mark settlement as settled (finalize it)
 * Blocked if brandSlipAmount is not set yet
 * Blocked if already settled (G2)
 */
exports.markSettled = async (req, res) => {
  try {
    const { id } = req.body;
    const userId = req.user ? (req.user.id || req.user._id) : null;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await SalarySettlementRecord.findOne({ _id: id, ...tenantFilter });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Settlement record not found",
      });
    }

    // G2: Already settled
    if (record.status === "settled") {
      return res.status(409).json({
        success: false,
        message: "Record already settled",
      });
    }

    // Require brandSlipAmount before settling
    if (record.brandSlipAmount === null || record.brandSlipAmount === undefined) {
      return res.status(400).json({
        success: false,
        message: "Brand slip amount must be set before settling",
      });
    }

    // Mark settled
    record.status = "settled";
    record.settledAt = new Date();
    record.settledBy = userId;
    await record.save();

    res.status(200).json({
      success: true,
      message: "Settlement marked as settled",
      data: record,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to mark settlement",
    });
  }
};

/**
 * Delete a settlement record.
 * Pending records delete freely; settled records are immutable (G2) and
 * require an explicit ?force=true — a deliberate admin correction, distinct
 * from a silent overwrite.
 */
exports.deleteSettlement = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const record = await SalarySettlementRecord.findOne({ _id: req.params.id, ...tenantFilter });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Settlement record not found",
      });
    }

    if (record.status === "settled" && req.query.force !== "true") {
      return res.status(409).json({
        success: false,
        message:
          "Record is settled and immutable. Pass force=true to permanently delete it as an admin correction.",
      });
    }

    await record.deleteOne();

    res.json({
      success: true,
      message: "Settlement record deleted",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Failed to delete settlement record",
    });
  }
};

/**
 * List settlements with filters
 */
exports.listSettlements = async (req, res) => {
  try {
    const { month, year, managingCompanyId, employeeId, status, direction } = req.query;
    const query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    if (month) query.month = Number(month);
    if (year) query.year = Number(year);
    if (managingCompanyId && managingCompanyId !== "all")
      query.managingCompanyId = managingCompanyId;
    if (employeeId) query.employeeId = employeeId;
    if (status && status !== "all") query.status = status;
    if (direction && direction !== "all") query.direction = direction;

    // Not populating salespersonId — the "Salesperson" model it refs is an
    // unimplemented stub (src/hrms/models/salesperson_model.js), so populating
    // it always throws "Schema hasn't been registered for model 'Salesperson'"
    // and silently 500s this whole list. Nothing in the UI reads it anyway.
    const records = await SalarySettlementRecord.find(query)
      .populate("employeeId", "name email")
      .populate("managingCompanyId", "name")
      .populate("settledBy", "name")
      .sort({ year: -1, month: -1, createdAt: -1 });

    res.json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to list settlements",
    });
  }
};

/**
 * Get settlement history for one employee
 */
exports.getEmployeeSettlementHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    const records = await SalarySettlementRecord.find({ employeeId, ...tenantFilter })
      .populate("managingCompanyId", "name")
      .populate("settledBy", "name")
      .sort({ year: -1, month: -1 });

    res.json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch settlement history",
    });
  }
};

/**
 * Get aggregated settlement summary for a given month/year
 * Totals: employee→GE, GE→employee, net, per managing company
 */
exports.getSettlementSummary = async (req, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: "month and year are required",
      });
    }

    const query = {
      month: Number(month),
      year: Number(year),
      status: "settled",
      tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null),
    };

    const records = await SalarySettlementRecord.find(query).populate(
      "managingCompanyId",
      "name"
    );

    const summary = {
      totalEmployeeToGE: 0,
      totalGEToEmployee: 0,
      net: 0,
      byManagingCompany: {},
    };

    records.forEach((record) => {
      const amount = record.settlementAmount || 0;
      const companyName = record.managingCompanyId?.name || "Unknown";

      if (!summary.byManagingCompany[companyName]) {
        summary.byManagingCompany[companyName] = {
          employeeToGE: 0,
          geToEmployee: 0,
          net: 0,
        };
      }

      if (record.direction === "employee_to_ge") {
        summary.totalEmployeeToGE += amount;
        summary.byManagingCompany[companyName].employeeToGE += amount;
      } else if (record.direction === "ge_to_employee") {
        summary.totalGEToEmployee += amount;
        summary.byManagingCompany[companyName].geToEmployee += amount;
      }
    });

    summary.net = summary.totalEmployeeToGE - summary.totalGEToEmployee;
    Object.keys(summary.byManagingCompany).forEach((company) => {
      summary.byManagingCompany[company].net =
        summary.byManagingCompany[company].employeeToGE -
        summary.byManagingCompany[company].geToEmployee;
    });

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch settlement summary",
    });
  }
};
