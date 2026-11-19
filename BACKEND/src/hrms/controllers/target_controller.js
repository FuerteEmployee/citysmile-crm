const TargetProfile = require("../models/target_profile_model");
const IncentiveEarning = require("../models/incentive_earning_model");
const User = require("../models/user_model");

// Helper to calculate incentive rate based on achievement percentage
const calculateIncentiveRate = (achieved, target) => {
  if (!target || target <= 0) return 0;
  const pct = (achieved / target) * 100;
  if (pct < 80) return 0;
  if (pct < 100) return 0.5;
  if (pct < 120) return 1.0;
  return 1.5;
};

// Seed default target profiles if empty
const seedDefaultTargets = async (tenant_id) => {
  try {
    const activeUsers = await User.find({ isActive: true, tenant_id }).limit(3);
    if (activeUsers.length === 0) return;

    const currentMonth = new Date().getMonth() + 1; // 1-12
    const currentYear = new Date().getFullYear();

    const defaults = [
      { employeeId: activeUsers[0]._id, month: currentMonth, year: currentYear, revenueTarget: 500000, marginTargetPercent: 15, tenant_id },
    ];
    if (activeUsers.length > 1) {
      defaults.push({ employeeId: activeUsers[1]._id, month: currentMonth, year: currentYear, revenueTarget: 400000, marginTargetPercent: 15, tenant_id });
    }
    if (activeUsers.length > 2) {
      defaults.push({ employeeId: activeUsers[2]._id, month: currentMonth, year: currentYear, revenueTarget: 600000, marginTargetPercent: 12, tenant_id });
    }

    for (const d of defaults) {
      // Check if target already exists to avoid duplication
      const existing = await TargetProfile.findOne({ employeeId: d.employeeId, month: d.month, year: d.year });
      if (!existing) {
        const target = new TargetProfile(d);
        await target.save();

        // Seed matching incentive earning
        // Random achievements between 80% and 125% of target
        const mult = 0.8 + Math.random() * 0.45;
        const achievedRevenue = Math.round(d.revenueTarget * mult);
        const achievedMargin = Math.round(d.marginTargetPercent * (0.9 + Math.random() * 0.2));
        const rate = calculateIncentiveRate(achievedRevenue, d.revenueTarget);
        const calculatedIncentive = Math.round(achievedRevenue * (rate / 100));

        const earning = new IncentiveEarning({
          employeeId: d.employeeId,
          month: d.month,
          year: d.year,
          targetProfileId: target._id,
          achievedRevenue,
          achievedMargin,
          calculatedIncentive,
          approvedIncentive: calculatedIncentive,
          status: "pending"
        });
        await earning.save();
      }
    }
  } catch (error) {
    console.error("Error seeding default targets:", error);
  }
};

exports.getTargets = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    let targets = await TargetProfile.find(tenantFilter)
      .populate("employeeId", "name employeeId")
      .populate("assignedBy", "name");

    if (targets.length === 0) {
      await seedDefaultTargets(tenantFilter.tenant_id);
      targets = await TargetProfile.find(tenantFilter)
        .populate("employeeId", "name employeeId")
        .populate("assignedBy", "name");
    }

    const mergedData = [];

    for (const target of targets) {
      if (!target.employeeId) continue; // Skip orphaned targets

      // Find or create associated incentive earning
      let earning = await IncentiveEarning.findOne({
        employeeId: target.employeeId._id,
        month: target.month,
        year: target.year
      });

      if (!earning) {
        // Create an earning profile on-the-fly with realistic achievements
        const mult = 0.8 + Math.random() * 0.4;
        const achievedRevenue = Math.round(target.revenueTarget * mult);
        const achievedMargin = Math.round(target.marginTargetPercent * (0.9 + Math.random() * 0.2));
        const rate = calculateIncentiveRate(achievedRevenue, target.revenueTarget);
        const calculatedIncentive = Math.round(achievedRevenue * (rate / 100));

        earning = new IncentiveEarning({
          employeeId: target.employeeId._id,
          month: target.month,
          year: target.year,
          targetProfileId: target._id,
          achievedRevenue,
          achievedMargin,
          calculatedIncentive,
          approvedIncentive: calculatedIncentive,
          status: "pending"
        });
        await earning.save();
      }

      const rate = calculateIncentiveRate(earning.achievedRevenue, target.revenueTarget);

      mergedData.push({
        _id: target._id,
        employeeId: target.employeeId._id,
        name: target.employeeId.name,
        employeeIdCode: target.employeeId.employeeId || `USR-${target.employeeId._id.toString().slice(-3).toUpperCase()}`,
        month: target.month,
        year: target.year,
        revenueTarget: target.revenueTarget,
        revenueAchieved: earning.achievedRevenue,
        marginTarget: target.marginTargetPercent,
        actualMargin: earning.achievedMargin,
        incentive: `${rate.toFixed(1)}%`,
        incentiveAmount: earning.calculatedIncentive || 0,
        status: target.status,
        assignedBy: target.assignedBy ? target.assignedBy.name : "System"
      });
    }

    res.status(200).json({ success: true, data: mergedData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createTarget = async (req, res) => {
  try {
    const { employeeId, month, year, revenueTarget, marginTargetPercent, achievedRevenue, achievedMargin } = req.body;

    // Check if target already exists
    const existing = await TargetProfile.findOne({ employeeId, month, year });
    if (existing) {
      return res.status(400).json({ success: false, message: "Target profile already exists for this employee for this month/year." });
    }

    const assignedBy = req.user?.userId || req.user?._id || req.user?.id;

    const target = new TargetProfile({
      employeeId,
      month,
      year,
      revenueTarget,
      marginTargetPercent,
      assignedBy,
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    });
    await target.save();

    // Setup associated IncentiveEarning
    const revAch = Number(achievedRevenue) || 0;
    const marAch = Number(achievedMargin) || 0;
    const rate = calculateIncentiveRate(revAch, revenueTarget);
    const calculatedIncentive = Math.round(revAch * (rate / 100));

    const earning = new IncentiveEarning({
      employeeId,
      month,
      year,
      targetProfileId: target._id,
      achievedRevenue: revAch,
      achievedMargin: marAch,
      calculatedIncentive,
      approvedIncentive: calculatedIncentive,
      status: "pending"
    });
    await earning.save();

    const populated = await TargetProfile.findById(target._id).populate("employeeId", "name employeeId");

    res.status(201).json({
      success: true,
      data: {
        _id: target._id,
        employeeId: populated.employeeId._id,
        name: populated.employeeId.name,
        employeeIdCode: populated.employeeId.employeeId,
        month: target.month,
        year: target.year,
        revenueTarget: target.revenueTarget,
        revenueAchieved: earning.achievedRevenue,
        marginTarget: target.marginTargetPercent,
        actualMargin: earning.achievedMargin,
        incentive: `${rate.toFixed(1)}%`,
        incentiveAmount: earning.calculatedIncentive,
        status: target.status
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.updateTarget = async (req, res) => {
  try {
    const { revenueTarget, marginTargetPercent, achievedRevenue, achievedMargin, status } = req.body;

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const target = await TargetProfile.findOne({ _id: req.params.id, ...tenantFilter });
    if (!target) {
      return res.status(404).json({ success: false, message: "Target profile not found" });
    }

    if (revenueTarget !== undefined) target.revenueTarget = revenueTarget;
    if (marginTargetPercent !== undefined) target.marginTargetPercent = marginTargetPercent;
    if (status !== undefined) target.status = status;
    await target.save();

    // Find and update incentive earning
    let earning = await IncentiveEarning.findOne({
      employeeId: target.employeeId,
      month: target.month,
      year: target.year
    });

    if (!earning) {
      earning = new IncentiveEarning({
        employeeId: target.employeeId,
        month: target.month,
        year: target.year,
        targetProfileId: target._id
      });
    }

    if (achievedRevenue !== undefined) earning.achievedRevenue = achievedRevenue;
    if (achievedMargin !== undefined) earning.achievedMargin = achievedMargin;

    const currentRevenueTarget = revenueTarget !== undefined ? revenueTarget : target.revenueTarget;
    const rate = calculateIncentiveRate(earning.achievedRevenue, currentRevenueTarget);
    earning.calculatedIncentive = Math.round(earning.achievedRevenue * (rate / 100));
    earning.approvedIncentive = earning.calculatedIncentive;
    
    await earning.save();

    const populated = await TargetProfile.findById(target._id).populate("employeeId", "name employeeId");

    res.status(200).json({
      success: true,
      data: {
        _id: target._id,
        employeeId: populated.employeeId._id,
        name: populated.employeeId.name,
        employeeIdCode: populated.employeeId.employeeId,
        month: target.month,
        year: target.year,
        revenueTarget: target.revenueTarget,
        revenueAchieved: earning.achievedRevenue,
        marginTarget: target.marginTargetPercent,
        actualMargin: earning.achievedMargin,
        incentive: `${rate.toFixed(1)}%`,
        incentiveAmount: earning.calculatedIncentive,
        status: target.status
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteTarget = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const target = await TargetProfile.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!target) {
      return res.status(404).json({ success: false, message: "Target profile not found" });
    }

    // Delete associated incentive earning
    await IncentiveEarning.findOneAndDelete({
      employeeId: target.employeeId,
      month: target.month,
      year: target.year
    });

    res.status(200).json({ success: true, message: "Target deleted successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
