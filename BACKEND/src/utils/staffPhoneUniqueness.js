const { toE164 } = require("./phoneNormalize");

// A staff member's mobile number must be unique within one company (tenant),
// but the same number may exist in a different company. Used by both the CRM
// Setup > Staff screens (Staff.phonenumber) and the HRMS employee screens
// (User.mobile) so both apply the same rule.

const DUPLICATE_PHONE_MESSAGE =
  "This mobile number is already used by another staff member in your company";

// Comparable key for a phone number: E.164 when it parses (so "+91 98765 43210",
// "098765 43210" and "9876543210" all match), else the last 10 digits — keeps
// test/odd numbers that libphonenumber rejects comparable too.
const phoneKey = (raw) => {
  if (raw === null || raw === undefined) return "";
  const e164 = toE164(raw);
  if (e164) return e164;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// Stored numbers aren't normalized, so compare in JS over the tenant's own
// staff (a per-tenant list, small enough to scan).
const loadTenantPhoneKeys = async (Model, field, tenant_id, excludeId) => {
  const query = { tenant_id: tenant_id || null, [field]: { $nin: [null, ""] } };
  if (excludeId) query._id = { $ne: excludeId };
  const docs = await Model.find(query).select(field).lean();
  return new Set(docs.map((d) => phoneKey(d[field])).filter(Boolean));
};

/** True when `phone` is already used by another record in the same tenant. */
const isPhoneTakenInTenant = async (Model, field, phone, tenant_id, excludeId) => {
  const key = phoneKey(phone);
  if (!key) return false;
  const keys = await loadTenantPhoneKeys(Model, field, tenant_id, excludeId);
  return keys.has(key);
};

module.exports = { DUPLICATE_PHONE_MESSAGE, phoneKey, loadTenantPhoneKeys, isPhoneTakenInTenant };
