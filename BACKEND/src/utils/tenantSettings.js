const Setting = require("../models/Setting");

// Reads Setup > Settings values for a company: its own row first, then the
// global (tenant_id null) row. Missing names come back as undefined.
const readSettings = async (tenantId, names) => {
  const rows = await Setting.find({ name: { $in: names }, $or: [{ tenant_id: tenantId || null }, { tenant_id: null }] }).lean();
  const out = {};
  for (const name of names) {
    const own = tenantId ? rows.find((r) => r.name === name && String(r.tenant_id) === String(tenantId)) : null;
    out[name] = (own ?? rows.find((r) => r.name === name && r.tenant_id == null))?.value;
  }
  return out;
};

const isOn = (v) => v === true || v === 1 || v === "1" || v === "true";

const isAdminUser = (user) => !!(user?.is_superadmin || user?.admin === true || user?.admin === 1 || user?.admin === "1" || user?.admin === "true");

module.exports = { readSettings, isOn, isAdminUser };














