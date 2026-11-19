const GdprSetting = require("../models/GdprSetting");

exports.getGdprSettings = async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id;
    const filter = tenantId ? { tenant_id: tenantId } : { tenant_id: null };
    const doc = await GdprSetting.findOne(filter);
    res.json(doc?.settings || {});
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateGdprSettings = async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id;
    const filter = tenantId ? { tenant_id: tenantId } : { tenant_id: null };
    const doc = await GdprSetting.findOneAndUpdate(
      filter,
      { tenant_id: tenantId || null, settings: req.body },
      { upsert: true, new: true, runValidators: true }
    );
    res.json(doc.settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
