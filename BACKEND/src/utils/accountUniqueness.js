const Staff = require("../models/Staff");
const User = require("../hrms/models/user_model");
const Tenant = require("../models/Tenant");

// One email and one mobile number = one login account across the WHOLE
// software (every company): company owners/admins, Setup staff, HRMS staff
// and super admins. A person's own Staff login and its linked HRMS profile
// are one account, never a duplicate of each other.
//
// Ignored as "not a real account any more":
//   - records of a company that no longer exists (leftovers of old deletes)
//   - an HRMS profile that was switched off and whose login is gone
//     (deleted staff, or never linked)
//
// Mobile numbers must be exactly 10 digits ("+91 98765 43210" is accepted
// and stored as 9876543210).

const EMAIL_TAKEN_MESSAGE = "This email is already used by another account";
const PHONE_TAKEN_MESSAGE = "This mobile number is already used by another account";
const PHONE_INVALID_MESSAGE = "Mobile number must be exactly 10 digits";
const PHONE_REQUIRED_MESSAGE = "Mobile number is required (10 digits)";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

/**
 * Normalizes a mobile number to exactly 10 digits.
 * Returns { phone } ("" when empty) or { error }.
 */
const normalizePhone = (raw) => {
  if (raw === undefined || raw === null) return { phone: "" };
  // Formatting (+, spaces, dashes, brackets, dots) is fine; letters mean a typo, not a number.
  if (/[^\d\s+\-().]/.test(String(raw))) return { error: PHONE_INVALID_MESSAGE };
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 0) return { phone: "" };
  if (digits.length !== 10) return { error: PHONE_INVALID_MESSAGE };
  return { phone: digits };
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const idStr = (v) => (v ? String(v._id || v) : "");

// Is `rec` the account being saved (itself, or its linked Staff/HRMS twin)?
const isSameAccount = (rec, ctx) => {
  const staffId = idStr(ctx.staffId);
  const userId = idStr(ctx.userId);
  if (rec.kind === "staff") {
    if (staffId && idStr(rec._id) === staffId) return true;
    if (userId && idStr(rec.hrms_user_id) === userId) return true;
  } else {
    if (userId && idStr(rec._id) === userId) return true;
    if (staffId && idStr(rec.staffId) === staffId) return true;
  }
  // Legacy pair linked only by email in the same company: the not-yet-linked
  // other half of this same person.
  if (ctx.email && ctx.tenantId !== undefined && normalizeEmail(rec.email) === normalizeEmail(ctx.email)) {
    const sameTenant = idStr(rec.tenant_id) === idStr(ctx.tenantId);
    const unlinked = rec.kind === "staff" ? !rec.hrms_user_id : !rec.staffId;
    if (sameTenant && unlinked && rec.kind !== ctx.kind) return true;
  }
  return false;
};

// Drop records that can't log in any more (see header).
const keepLiveAccounts = async (records) => {
  const tenantIds = [...new Set(records.map((r) => idStr(r.tenant_id)).filter(Boolean))];
  const existing = new Set(
    tenantIds.length ? (await Tenant.find({ _id: { $in: tenantIds } }).select("_id").lean()).map((t) => idStr(t._id)) : []
  );
  // Deleting a staff member only switches its HRMS profile off (attendance
  // history stays); such a profile must not block re-adding that person.
  const offLinkIds = records
    .filter((r) => r.kind === "user" && r.isActive === false && r.staffId)
    .map((r) => idStr(r.staffId));
  const liveLogins = new Set(
    offLinkIds.length ? (await Staff.find({ _id: { $in: offLinkIds } }).select("_id").lean()).map((s) => idStr(s._id)) : []
  );
  return records.filter((r) => {
    if (r.tenant_id && !existing.has(idStr(r.tenant_id))) return false; // company gone
    if (r.kind === "user" && r.isActive === false && !liveLogins.has(idStr(r.staffId))) return false; // switched off, login gone
    return true;
  });
};

const findOtherAccounts = async (filterStaff, filterUser, ctx) => {
  const [staff, users] = await Promise.all([
    filterStaff ? Staff.find(filterStaff).select("email phonenumber tenant_id hrms_user_id").lean() : [],
    filterUser ? User.find(filterUser).select("email mobile tenant_id staffId isActive").lean() : [],
  ]);
  const all = [...staff.map((s) => ({ ...s, kind: "staff" })), ...users.map((u) => ({ ...u, kind: "user" }))];
  return (await keepLiveAccounts(all)).filter((r) => !isSameAccount(r, ctx));
};

/**
 * Checks an account being created/updated.
 *
 * ctx: {
 *   kind: "staff" | "user",          which collection is being saved
 *   email, phone,                    values being saved (phone undefined = not changing)
 *   staffId, userId,                 ids of the account itself (and its twin), when known
 *   tenantId,                        the account's company (null for super admins)
 *   requirePhone,                    true on create
 * }
 * Returns { ok: true, email, phone } with normalized values, or
 * { ok: false, field: "email"|"phone", message }.
 */
const checkAccount = async (ctx) => {
  const email = ctx.email !== undefined ? normalizeEmail(ctx.email) : undefined;

  let phone;
  if (ctx.phone !== undefined || ctx.requirePhone) {
    const p = normalizePhone(ctx.phone);
    if (p.error) return { ok: false, field: "phone", message: p.error };
    if (!p.phone && ctx.requirePhone) return { ok: false, field: "phone", message: PHONE_REQUIRED_MESSAGE };
    phone = p.phone;
  }

  const full = { ...ctx, email: email ?? ctx.email };

  if (email) {
    const re = new RegExp(`^${escapeRegExp(email)}$`, "i");
    const others = await findOtherAccounts({ email: re }, { email: re }, full);
    if (others.length) return { ok: false, field: "email", message: EMAIL_TAKEN_MESSAGE };
  }

  if (phone) {
    // Stored numbers aren't all normalized ("+91 ..."), so match the last 10 digits.
    const re = new RegExp(`${phone.split("").join("\\D*")}\\D*$`);
    const others = await findOtherAccounts({ phonenumber: re }, { mobile: re }, full);
    if (others.length) return { ok: false, field: "phone", message: PHONE_TAKEN_MESSAGE };
  }

  return { ok: true, email, phone };
};

/** Sends a 400 with { message, field } and returns true when the check failed. */
const rejectAccountConflict = (res, result) => {
  if (result.ok) return false;
  res.status(400).json({ message: result.message, field: result.field });
  return true;
};

module.exports = {
  checkAccount,
  rejectAccountConflict,
  normalizeEmail,
  normalizePhone,
  EMAIL_TAKEN_MESSAGE,
  PHONE_TAKEN_MESSAGE,
  PHONE_INVALID_MESSAGE,
  PHONE_REQUIRED_MESSAGE,
};
