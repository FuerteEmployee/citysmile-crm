const mongoose = require("mongoose");
const CustomField = require("../models/CustomField");
const CustomFieldValue = require("../models/CustomFieldValue");
const CustomFieldService = require("../services/CustomFieldService");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");

// Custom fields belong to one company. A company sees its own fields plus
// legacy unowned ones (tenant_id null) until the migration assigns those, and
// can only change or delete its own. Super admins are not restricted.
const ownerTenant = (req) => (req.user?.is_superadmin ? null : req.user?.tenant_id || null);

const findEditable = (req) => {
  const query = { _id: req.params.id };
  // No tenant on a non-super-admin = match nothing (never fall through to the legacy null rows)
  if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id || new mongoose.Types.ObjectId();
  return CustomField.findOne(query);
};

const LEGACY_LOCKED =
  "This field was created before custom fields became per-company and is shared with other companies, so it can't be changed here yet. Please contact support.";
const DUPLICATE = "A custom field with this name already exists. Please use a different name.";

const getCustomFields = async (req, res) => {
  try {
    const { fieldto } = req.query;
    const query = { ...(fieldto ? { fieldto } : {}), ...CustomFieldService.tenantScope(ownerTenant(req)) };
    const fields = await CustomField.find(query).sort({ field_order: 1 });
    res.json(fields);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createCustomField = async (req, res) => {
  try {
    const body = withoutProtected(req.body);
    const tenantId = req.user?.is_superadmin ? req.body?.tenant_id || req.user?.tenant_id || null : req.user?.tenant_id;
    if (body.slug && body.fieldto && (await CustomFieldService.findBySlug(body.slug, body.fieldto, tenantId))) {
      return res.status(400).json({ message: DUPLICATE });
    }
    const field = await CustomField.create({ ...body, tenant_id: tenantId || null });
    res.status(201).json(field);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: DUPLICATE });
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const updateCustomField = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Field not found" });
    const field = await findEditable(req);
    if (field) {
      Object.assign(field, withoutProtected(req.body));
      const updatedField = await field.save();
      res.json(updatedField);
    } else if (await CustomField.exists({ _id: req.params.id, tenant_id: null })) {
      res.status(403).json({ message: LEGACY_LOCKED });
    } else {
      res.status(404).json({ message: "Field not found" });
    }
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: DUPLICATE });
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteCustomField = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Field not found" });
    const field = await findEditable(req);
    if (field) {
      // Delete associated values
      await CustomFieldValue.deleteMany({ fieldid: field._id });
      await field.deleteOne();
      res.json({ message: "Custom field and associated values removed" });
    } else if (await CustomField.exists({ _id: req.params.id, tenant_id: null })) {
      res.status(403).json({ message: LEGACY_LOCKED });
    } else {
      res.status(404).json({ message: "Field not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getCustomFields, createCustomField, updateCustomField, deleteCustomField };
