const IncentiveRule = require("../models/incentive_rule_model");
const { computeIncentiveFromRule } = require("../utils/incentive_calc");

// The partial unique indexes on scopeType+categoryId/brandId throw a raw
// Mongo E11000 error — surface a message an admin can actually act on.
function friendlyRuleError(err) {
  if (err.code === 11000) {
    return "An active rule is already scoped to this category/brand. Deactivate or edit that rule first.";
  }
  return err.message;
}

exports.getAll = async (req, res) => {
  try {
    const { active, scopeType, categoryId, brandId } = req.query;
    const query = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    if (active !== undefined) query.active = active === "true";
    if (scopeType) query.scopeType = scopeType;
    if (categoryId) query.categoryId = categoryId;
    if (brandId) query.brandId = brandId;

    const rules = await IncentiveRule.find(query)
      .populate("appliesToRoleId", "name label")
      .sort({ createdAt: -1 });

    res.json({ success: true, count: rules.length, data: rules });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const rule = await IncentiveRule.findOne({ _id: req.params.id, ...tenantFilter })
      .populate("appliesToRoleId", "name label");
    if (!rule) return res.status(404).json({ success: false, message: "Incentive rule not found" });
    res.json({ success: true, data: rule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Slab sanity check.
 *
 * The matcher in incentive_calc is a correct half-open interval —
 * `pct >= minPct && (maxPct == null || pct < maxPct)`, highest minPct first — but
 * nothing ever validated the slabs themselves. Configure 0–50 and 60–100 and
 * everyone landing between 51% and 59% silently earns ZERO incentive, with no
 * hint in the UI that a hole exists. Overlaps quietly resolve to the higher slab.
 *
 * Returns an error message, or null when the ladder is sound.
 */
const { checkNumber, firstError } = require("../utils/fieldRules");

// Fixed / percentage reward and the qualifying conditions: no negatives, % up to 100.
const rewardFieldError = (body) => firstError(
  checkNumber("Reward value", body.rewardValue, { min: 0, ...(body.rewardType === "percentage" ? { max: 100 } : {}) }),
  checkNumber("Min revenue required", body.conditions?.minRevenue, { min: 0 }),
  checkNumber("Min margin required (%)", body.conditions?.minMarginPercent, { min: 0, max: 100 }),
);

const validateSlabs = (body) => {
  if (body.rewardType !== "slab") return null;
  const slabs = Array.isArray(body.slabs) ? body.slabs : [];
  if (slabs.length === 0) return "A slab rule needs at least one slab.";

  const parsed = slabs.map((s, i) => ({
    i,
    min: Number(s.minPct),
    max: s.maxPct === null || s.maxPct === undefined || s.maxPct === "" ? null : Number(s.maxPct),
  }));

  for (const [i, raw] of slabs.entries()) {
    if (raw.value === "" || raw.value === null || raw.value === undefined) continue; // schema default 0
    const value = Number(raw.value);
    if (!Number.isFinite(value) || value < 0) {
      return `Slab ${i + 1}: incentive must be a number of 0 or more.`;
    }
    if ((raw.type || "percentage") === "percentage" && value > 100) return `Slab ${i + 1}: incentive % cannot be more than 100.`;
  }

  for (const s of parsed) {
    if (!Number.isFinite(s.min) || s.min < 0) return `Slab ${s.i + 1}: "from %" must be a number of 0 or more.`;
    if (s.max !== null && !Number.isFinite(s.max)) return `Slab ${s.i + 1}: "to %" must be a number, or blank for no upper limit.`;
    if (s.max !== null && s.max <= s.min) return `Slab ${s.i + 1}: "to %" (${s.max}) must be greater than "from %" (${s.min}).`;
  }

  // At most one open-ended slab, and it has to be the highest.
  const openEnded = parsed.filter((s) => s.max === null);
  if (openEnded.length > 1) return "Only one slab may be left open-ended (blank \"to %\").";

  const ordered = [...parsed].sort((a, b) => a.min - b.min);
  if (openEnded.length === 1 && ordered[ordered.length - 1].max !== null) {
    return "The open-ended slab must be the highest one.";
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (prev.max === null) continue; // already rejected unless it is last
    if (cur.min < prev.max) {
      return `Slabs overlap: ${prev.min}–${prev.max}% and ${cur.min}–${cur.max ?? "∞"}%. ` +
        "Achievement in the overlap would silently take the higher slab.";
    }
    if (cur.min > prev.max) {
      return `Gap between slabs: nothing covers ${prev.max}% up to ${cur.min}%. ` +
        "Anyone landing in that range would earn no incentive at all.";
    }
  }

  return null;
};

exports.create = async (req, res) => {
  try {
    const invalidSlabs = validateSlabs(req.body) || rewardFieldError(req.body);
    if (invalidSlabs) {
      return res.status(400).json({ success: false, message: invalidSlabs });
    }
    const rule = new IncentiveRule({
      ...req.body,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await rule.save();
    res.status(201).json({ success: true, data: rule });
  } catch (err) {
    res.status(400).json({ success: false, message: friendlyRuleError(err) });
  }
};

exports.update = async (req, res) => {
  try {
    // Only validate when the payload actually carries slabs — a PATCH-style
    // update of just the name must not be rejected for omitting them.
    if (req.body.rewardType === "slab" || req.body.slabs !== undefined) {
      const invalidSlabs = validateSlabs({
        rewardType: req.body.rewardType || "slab",
        slabs: req.body.slabs,
      });
      if (invalidSlabs) {
        return res.status(400).json({ success: false, message: invalidSlabs });
      }
    }

    const invalidReward = rewardFieldError(req.body);
    if (invalidReward) return res.status(400).json({ success: false, message: invalidReward });

    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const rule = await IncentiveRule.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      body,
      { returnDocument: "after", runValidators: true }
    )
      .populate("appliesToRoleId", "name label");
    if (!rule) return res.status(404).json({ success: false, message: "Incentive rule not found" });
    res.json({ success: true, data: rule });
  } catch (err) {
    res.status(400).json({ success: false, message: friendlyRuleError(err) });
  }
};

exports.delete = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const rule = await IncentiveRule.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!rule) return res.status(404).json({ success: false, message: "Incentive rule not found" });
    res.json({ success: true, message: "Incentive rule deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Calculate incentive for a given achievement percentage using a rule
exports.calculate = async (req, res) => {
  try {
    const { ruleId, achievedAmount, targetAmount } = req.body;
    if (!ruleId || targetAmount == null || achievedAmount == null) {
      return res.status(400).json({ success: false, message: "ruleId, achievedAmount, targetAmount required" });
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const rule = await IncentiveRule.findOne({ _id: ruleId, ...tenantFilter });
    if (!rule) return res.status(404).json({ success: false, message: "Rule not found" });

    const { pct, incentiveAmount } = computeIncentiveFromRule(rule, achievedAmount, targetAmount);

    res.json({ success: true, data: { achievementPct: pct, incentiveAmount } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
