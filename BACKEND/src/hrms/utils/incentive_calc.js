// Pure reward-math helpers for IncentiveRule — kept separate from
// sales_achievement.js, which handles achievement aggregation, a different concern.

function computeIncentiveFromRule(rule, achievedAmount, targetAmount) {
  const pct = targetAmount > 0 ? (achievedAmount / targetAmount) * 100 : 0;
  let incentiveAmount = 0;
  let label = "0%";

  if (rule.rewardType === "fixed") {
    incentiveAmount = rule.rewardValue;
    label = `₹${rule.rewardValue}`;
  } else if (rule.rewardType === "percentage") {
    incentiveAmount = (achievedAmount * rule.rewardValue) / 100;
    label = `${rule.rewardValue}%`;
  } else if (rule.rewardType === "slab" && rule.slabs.length > 0) {
    const slab = [...rule.slabs]
      .sort((a, b) => b.minPct - a.minPct) // highest first
      .find((s) => pct >= s.minPct && (s.maxPct == null || pct < s.maxPct));
    if (slab) {
      incentiveAmount = slab.type === "fixed" ? slab.value : (achievedAmount * slab.value) / 100;
      label = slab.type === "fixed" ? `₹${slab.value}` : `${slab.value}%`;
    }
  }

  return { pct, incentiveAmount: Math.round(incentiveAmount), label };
}

// Given an array of active rules (any sort order — ties broken by array order,
// so callers should pass rules pre-sorted createdAt desc for "most recent wins"),
// find the one scoped to the given category/brand id.
function resolveScopedRule(activeRules, scopeType, id) {
  if (!id) return null;
  const targetId = String(id);
  return (
    activeRules.find((r) => {
      if (r.scopeType !== scopeType) return false;
      const ruleScopeId = scopeType === "category" ? r.categoryId : r.brandId;
      return ruleScopeId && String(ruleScopeId) === targetId;
    }) || null
  );
}

// Overall-target incentive: use the assigned rule's real math when one is
// set, otherwise fall back to the legacy flat slab guideline.
function computeOverallIncentive(target, revenueAchieved, assignedRule) {
  if (assignedRule) {
    return computeIncentiveFromRule(assignedRule, revenueAchieved, target.targetAmount);
  }
  const pct = target.targetAmount > 0 ? (revenueAchieved / target.targetAmount) * 100 : 0;
  let flatRate = 0;
  if (pct >= 80 && pct < 100) flatRate = 0.5;
  else if (pct >= 100 && pct < 120) flatRate = 1.0;
  else if (pct >= 120) flatRate = 1.5;
  const incentiveAmount = Math.round(revenueAchieved * (flatRate / 100));
  return { pct, incentiveAmount, label: `${flatRate.toFixed(1)}%` };
}

module.exports = { computeIncentiveFromRule, resolveScopedRule, computeOverallIncentive };
