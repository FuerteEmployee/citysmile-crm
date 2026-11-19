const mongoose = require("mongoose");
const ManagingCompany = require("../models/managing_company_model");
const HRMSBranch = require("../models/hrms_branch_model");

// Companies that use "Salary Managed By: Branch" — fixed in code, not a
// super-admin add-on (Trinetra / Rudraverse, owner info@trinetratechnoworld.com).
// Must match CRM-FRONTEND-NEW/src/lib/branchSalary.ts.
const BRANCH_SALARY_TENANT_IDS = []; // City Smile: not used

// "Salary Managed By: Branch" is chosen from the company's HRMS branches, but
// salary settlements (salary_settlement_controller.js) are keyed by
// ManagingCompany. Each branch gets one ManagingCompany of the same name,
// linked via hrmsBranchId, so the ledger keeps working unchanged.
const resolveBranchManagingCompany = async (branchId, tenantId) => {
  if (!branchId || !mongoose.Types.ObjectId.isValid(String(branchId))) return null;
  const tenant_id = tenantId || null;
  const branch = await HRMSBranch.findOne({ _id: branchId, tenant_id });
  if (!branch) return null;

  const linked = await ManagingCompany.findOne({ tenant_id, hrmsBranchId: branch._id });
  if (linked) return linked._id;

  // A company with the branch's name may already exist (added by hand via
  // HRMS > Managing Companies) — link it rather than hit the unique name index.
  const sameName = await ManagingCompany.findOne({ tenant_id, name: branch.name, hrmsBranchId: null });
  if (sameName) {
    sameName.hrmsBranchId = branch._id;
    await sameName.save();
    return sameName._id;
  }

  const created = await ManagingCompany.create({ name: branch.name, tenant_id, hrmsBranchId: branch._id });
  return created._id;
};

const branchIdForManagingCompany = async (managingCompanyId) => {
  if (!managingCompanyId || !mongoose.Types.ObjectId.isValid(String(managingCompanyId))) return "";
  const company = await ManagingCompany.findById(managingCompanyId).select("hrmsBranchId");
  return company?.hrmsBranchId ? String(company.hrmsBranchId) : "";
};

// Turns the form's "managingBranchId" into the managingCompanyId stored on
// User. Mutates hrmsFields; a no-op when the form didn't send a branch choice.
const applyManagingBranch = async (body, hrmsFields, tenantId) => {
  if (body.managingBranchId === undefined) return;
  // Other companies don't see these fields; leave their stored values untouched.
  if (!tenantId || !BRANCH_SALARY_TENANT_IDS.includes(String(tenantId))) return;
  if (body.salaryManagedBy === "branch") {
    hrmsFields.managingCompanyId = await resolveBranchManagingCompany(body.managingBranchId, tenantId);
  } else {
    hrmsFields.managingCompanyId = null;
  }
};

module.exports = { resolveBranchManagingCompany, branchIdForManagingCompany, applyManagingBranch };
