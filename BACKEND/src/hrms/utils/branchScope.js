// Branch-wise supervisor scoping.
//
// A user who is listed in HRMSBranch.supervisorIds (and is not a tenant
// admin / owner / super admin) is a "supervisor": every HRMS list they load is
// narrowed to employees of the branches they supervise, and they can only
// approve/act on those employees. Everyone else keeps their existing access —
// scope === null means "no branch restriction".

const HRMSBranch = require("../models/hrms_branch_model");
const User = require("../models/user_model");

const ADMIN_ROLE_KEYS = ["admin", "owner", "super_admin", "superadmin"];

const tenantOf = (req) => (req.user?.is_superadmin ? null : (req.user?.tenant_id || null));

async function isTenantAdmin(req) {
  if (req.user?.admin || req.user?.is_superadmin) return true;
  if (!req.user?.userId) return false;
  const me = await User.findById(req.user.userId).select("role").populate("role", "role");
  return ADMIN_ROLE_KEYS.includes(String(me?.role?.role || "").toLowerCase());
}

/**
 * @returns {Promise<null | { branchIds: ObjectId[], branchNames: string[] }>}
 *   null for admins and non-supervisors (unrestricted, existing behaviour).
 */
async function getBranchScope(req) {
  if (req._branchScope !== undefined) return req._branchScope;
  let scope = null;
  if (req.user?.userId && !(await isTenantAdmin(req))) {
    const branches = await HRMSBranch.find({ tenant_id: tenantOf(req), supervisorIds: req.user.userId }).select("_id name");
    if (branches.length) {
      scope = { branchIds: branches.map((b) => b._id), branchNames: branches.map((b) => b.name) };
    }
  }
  req._branchScope = scope;
  return scope;
}

// Extra User filter to AND into an employee query ({} when unrestricted).
async function scopedUserFilter(req) {
  const scope = await getBranchScope(req);
  return scope ? { hrmsBranchId: { $in: scope.branchIds } } : {};
}

// Ids of the employees a supervisor may see (their branches' staff + themselves,
// so their own "My ..." pages keep working), or null when unrestricted.
async function scopedUserIds(req) {
  const scope = await getBranchScope(req);
  if (!scope) return null;
  const users = await User.find({ tenant_id: tenantOf(req), hrmsBranchId: { $in: scope.branchIds } }).select("_id");
  const ids = users.map((u) => u._id);
  if (!ids.some((id) => String(id) === String(req.user.userId))) ids.push(req.user.userId);
  return ids;
}

/**
 * Whether the requester may approve / act on this employee's records.
 * - The employee must belong to the requester's company.
 * - Tenant admins / owners → true.
 * - Supervisors → only staff of their branches, never their own request.
 * - Anyone else → only with one of `perms` on their HRMS role, never their own record.
 */
async function canActOnEmployee(req, employeeId, perms = []) {
  const emp = await User.findById(employeeId).select("hrmsBranchId tenant_id");
  if (!emp) return false;
  // Legacy profiles without tenant_id keep the old behaviour; a different company never passes.
  if (!req.user?.is_superadmin && emp.tenant_id && String(emp.tenant_id) !== String(tenantOf(req))) return false;
  if (await isTenantAdmin(req)) return true;
  const isSelf = String(employeeId) === String(req.user?.userId);
  const scope = await getBranchScope(req);
  if (scope) {
    if (isSelf) return false;
    return !!emp.hrmsBranchId && scope.branchIds.some((id) => String(id) === String(emp.hrmsBranchId));
  }
  if (isSelf || !perms.length) return false;
  const { loadRole } = require("../middleware/authorize");
  const u = await loadRole(req);
  const mine = u?.permissions || [];
  return mine.includes("*") || perms.some((p) => mine.includes(p));
}

const OUT_OF_SCOPE_MESSAGE = "You can only manage staff of the branches you supervise";

module.exports = { getBranchScope, scopedUserFilter, scopedUserIds, canActOnEmployee, isTenantAdmin, OUT_OF_SCOPE_MESSAGE };
