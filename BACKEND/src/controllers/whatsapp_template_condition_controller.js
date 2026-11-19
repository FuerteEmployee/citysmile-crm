const WhatsAppTemplateCondition = require("../models/WhatsAppTemplateCondition");

const getConditions = async (req, res) => {
  try {
    const conditions = await WhatsAppTemplateCondition.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: -1 });
    res.json({ data: conditions });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createCondition = async (req, res) => {
  try {
    const { tenant_id, created_by, _id, ...data } = req.body;
    const condition = await WhatsAppTemplateCondition.create({
      ...data,
      tenant_id: req.user.tenant_id,
      created_by: req.user._id,
    });
    res.json(condition);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A condition already exists for this template" });
    }
    res.status(500).json({ message: error.message });
  }
};

// Only the rule's own settings can be edited — never tenant_id / created_by.
const EDITABLE_FIELDS = ["template_id", "label", "recency_days", "frequency_cap", "exclude_statuses", "include_statuses", "is_active"];

const updateCondition = async (req, res) => {
  try {
    const updates = {};
    for (const key of EDITABLE_FIELDS) if (req.body[key] !== undefined) updates[key] = req.body[key];
    const condition = await WhatsAppTemplateCondition.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      updates,
      { new: true, runValidators: true }
    );
    if (!condition) return res.status(404).json({ message: "Condition not found" });
    res.json(condition);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCondition = async (req, res) => {
  try {
    const deleted = await WhatsAppTemplateCondition.findOneAndDelete({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!deleted) return res.status(404).json({ message: "Condition not found" });
    res.json({ message: "Condition deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getConditions, createCondition, updateCondition, deleteCondition };
