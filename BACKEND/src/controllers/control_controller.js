const mongoose = require("mongoose");
const Tenant = require("../models/Tenant");
const SaasPlan = require("../models/SaasPlan");
const Staff = require("../models/Staff");
const { invalidateTenantAccess } = require("../utils/tenantAccess");
const { invalidatePlanModules } = require("../middleware/planModules");
const { TENANT_FEATURE_KEYS } = require("../config/tenantFeatures");
const pkg = require("../../package.json");

// Server-to-server API used by the separate Super Admin panel to manage the
// companies on THIS server (see middleware/controlAuth.js). The Super Admin is
// the master: it sends final values (dates already worked out), and this server
// only stores them and clears its caches so they apply on the next request.
//
// On a dedicated client server TENANT_ID is set, and only that company can be
// read or changed here.

const STATUSES = ["active", "inactive", "trial", "expired"];
const TENANT_FIELDS = [
  "company_name",
  "status",
  "enabled_features",
  "sidebar_config",
  "hidden_hrms_features",
  "enabled_beta_features",
  "custom_domains",
  "trial_ends_at",
  "billing_cycle_start",
  "billing_cycle_end",
  "settings",
];
const PLAN_FIELDS = ["module_access", "features", "price", "billing_cycle", "trial_days", "banner_warning_days", "description", "active"];

const lockedTenantId = () => process.env.TENANT_ID || null;

// 404 (not 403) for a company this server doesn't own, so ids can't be probed.
const resolveTenantId = (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: "Invalid company id" });
    return null;
  }
  const locked = lockedTenantId();
  if (locked && String(locked) !== String(id)) {
    res.status(404).json({ message: "Company not found on this server" });
    return null;
  }
  return id;
};

const summary = async (tenant) => {
  const staffCount = await Staff.countDocuments({ tenant_id: tenant._id, active: { $ne: false } });
  return {
    _id: tenant._id,
    company_name: tenant.company_name,
    status: tenant.status,
    plan: tenant.plan_id ? { _id: tenant.plan_id._id, name: tenant.plan_id.name } : null,
    trial_ends_at: tenant.trial_ends_at || null,
    billing_cycle_end: tenant.billing_cycle_end || null,
    enabled_features: tenant.enabled_features || [],
    custom_domains: tenant.custom_domains || [],
    staff_count: staffCount,
  };
};

// GET /api/control/status: is this server up, and which companies it holds.
exports.getStatus = async (req, res) => {
  try {
    const locked = lockedTenantId();
    const filter = locked ? { _id: locked } : {};
    const tenants = await Tenant.find(filter).select("-sidebar_config").populate("plan_id", "name").lean();
    res.json({
      ok: true,
      version: pkg.version,
      uptime_seconds: Math.round(process.uptime()),
      server_time: new Date().toISOString(),
      locked_tenant_id: locked,
      tenant_count: tenants.length,
      tenants: await Promise.all(tenants.map(summary)),
    });
  } catch (err) {
    res.status(500).json({ message: "Error reading server status", error: err.message });
  }
};

// GET /api/control/tenants/:id: the company's full settings + its plan.
exports.getTenant = async (req, res) => {
  try {
    const id = resolveTenantId(req, res);
    if (!id) return;
    const tenant = await Tenant.findById(id).populate("plan_id").lean();
    if (!tenant) return res.status(404).json({ message: "Company not found on this server" });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ message: "Error reading company", error: err.message });
  }
};

// PUT /api/control/tenants/:id
// Body: any of TENANT_FIELDS, plus optional `plan: { name, ...PLAN_FIELDS }`.
// The plan is matched by name on this server (created if missing) and linked.
exports.updateTenant = async (req, res) => {
  try {
    const id = resolveTenantId(req, res);
    if (!id) return;
    const existing = await Tenant.findById(id);
    if (!existing) return res.status(404).json({ message: "Company not found on this server" });

    const body = req.body || {};
    const update = {};
    for (const key of TENANT_FIELDS) if (body[key] !== undefined) update[key] = body[key];

    if (update.status !== undefined && !STATUSES.includes(update.status)) {
      return res.status(400).json({ message: `status must be one of: ${STATUSES.join(", ")}` });
    }
    if (update.company_name !== undefined) {
      update.company_name = String(update.company_name || "").trim();
      if (!update.company_name) return res.status(400).json({ message: "Company name is required" });
    }
    for (const key of ["enabled_features", "sidebar_config", "hidden_hrms_features", "enabled_beta_features", "custom_domains"]) {
      if (update[key] !== undefined && !Array.isArray(update[key])) {
        return res.status(400).json({ message: `${key} must be a list` });
      }
    }
    if (update.enabled_features) {
      const unknown = update.enabled_features.filter((k) => !TENANT_FEATURE_KEYS.includes(k));
      if (unknown.length) return res.status(400).json({ message: `Unknown add-on(s): ${unknown.join(", ")}` });
    }

    let planChanged = false;
    if (body.plan !== undefined) {
      if (body.plan === null) {
        update.plan_id = null;
      } else {
        const name = String(body.plan.name || "").trim();
        if (!name) return res.status(400).json({ message: "plan.name is required" });
        const planData = { name };
        for (const key of PLAN_FIELDS) {
          const value = body.plan[key];
          if (value === undefined) continue;
          // module_access / features: set each key on its own, so a partial
          // update never wipes the other modules (and defaults still apply).
          if (["module_access", "features"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
            for (const [sub, v] of Object.entries(value)) planData[`${key}.${sub}`] = v;
          } else {
            planData[key] = value;
          }
        }
        const plan = await SaasPlan.findOneAndUpdate({ name }, { $set: planData }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
        update.plan_id = plan._id;
      }
      planChanged = true;
    }

    const tenant = await Tenant.findByIdAndUpdate(id, update, { new: true, runValidators: true }).populate("plan_id").lean();

    invalidateTenantAccess(tenant._id);
    if (planChanged) invalidatePlanModules(); // a plan's modules may be shared by other companies here

    console.log(`[control] updated company ${tenant._id} (${tenant.company_name}): ${Object.keys(update).join(", ") || "no fields"}`);
    res.json(tenant);
  } catch (err) {
    res.status(400).json({ message: "Error updating company", error: err.message });
  }
};
