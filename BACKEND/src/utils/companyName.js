const Tenant = require("../models/Tenant");

// Company names must be unique (ignoring case and extra spaces), so the
// Super Admin lists never show two "Fuerte Developers".
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nameRegex = (name) => {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(`^\\s*${words.join("\\s+")}\\s*$`, "i");
};

/** The other company already using this name, or null. */
const findCompanyNameClash = async (name, excludeTenantId = null) => {
  if (!String(name || "").trim()) return null;
  const query = { company_name: nameRegex(name) };
  if (excludeTenantId) query._id = { $ne: excludeTenantId };
  return Tenant.findOne(query).select("company_name").lean();
};

const COMPANY_NAME_TAKEN = (name) => `A company named "${name}" already exists. Use a different name.`;

module.exports = { findCompanyNameClash, COMPANY_NAME_TAKEN, nameRegex };
