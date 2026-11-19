const WebsiteLeadForm = require("../models/WebsiteLeadForm");
const Lead = require("../models/Lead");
const LeadSource = require("../models/LeadSource");
const CustomField = require("../models/CustomField");
const CustomFieldService = require("../services/CustomFieldService");
const { getDefaultLeadStatus } = require("../utils/getDefaultLeadStatus");

const KNOWN_KEYS = new Set([
  "name", "full_name", "fullname",
  "email",
  "phone", "phone_number", "mobile", "phonenumber",
  "city",
]);

const pick = (body, keys) => {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
};

const humanize = (key) => key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// CustomField.slug is unique across the whole system (not scoped per fieldto),
// so every auto-created field gets a "leads_" prefix to avoid colliding with a
// same-named field already used by another module (e.g. an "items" "budget" field).
const toSlug = (key) =>
  `leads_${key}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const extraEntries = (body) =>
  Object.entries(body || {}).filter(
    ([key, value]) => !KNOWN_KEYS.has(key) && value !== undefined && value !== null && String(value).trim() !== ""
  );

// Any field the sender posts beyond name/email/phone/city (e.g. "Type of
// space", "Budget", "Timeline") becomes a real Lead custom field rather than
// free text, so it shows up as its own column/field wherever custom fields
// for "leads" are rendered — auto-creating the field definition on first use
// since a public landing page has no way to pre-register its fields.
const saveExtraFieldsAsCustomFields = async (leadId, body, formName) => {
  const entries = extraEntries(body);
  if (entries.length === 0) return;

  // Fields belong to the lead's company — never reuse or create another company's.
  const tenantId = (await Lead.findById(leadId).select("tenant_id").lean())?.tenant_id || null;
  const payload = {};
  for (const [key, value] of entries) {
    const slug = toSlug(key);
    let field = await CustomFieldService.findBySlug(slug, "leads", tenantId);
    if (!field) {
      const order = await CustomField.countDocuments({ fieldto: "leads", ...CustomFieldService.tenantScope(tenantId) });
      field = await CustomField.create({
        name: humanize(key),
        slug,
        fieldto: "leads",
        type: "input",
        field_order: order,
        show_on_table: true,
        active: true,
        tenant_id: tenantId,
      });
    }
    payload[field.slug] = String(value).trim();
  }

  await CustomFieldService.handlePost(leadId, "leads", payload, tenantId);
};

// @route   GET /api/website-lead-forms
const listForms = async (req, res) => {
  try {
    const forms = await WebsiteLeadForm.find({ tenant_id: req.user.tenant_id }).sort({ createdAt: -1 });
    res.json(forms);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route   POST /api/website-lead-forms
const createForm = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "A name for this form is required" });
    }
    const form = await WebsiteLeadForm.create({
      tenant_id: req.user.tenant_id,
      name: name.trim(),
      created_by: req.user._id,
    });
    res.status(201).json(form);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route   DELETE /api/website-lead-forms/:id
const deleteForm = async (req, res) => {
  try {
    const deleted = await WebsiteLeadForm.findOneAndDelete({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });
    if (!deleted) {
      return res.status(404).json({ message: "Form not found" });
    }
    res.json({ message: "Form deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route   POST /api/public/website-leads/:key  (no auth — called from the landing page)
const receiveLead = async (req, res) => {
  try {
    const form = await WebsiteLeadForm.findOne({ key: req.params.key });
    if (!form) {
      return res.status(404).json({ message: "Unknown form" });
    }

    const body = req.body || {};
    const name = pick(body, ["name", "full_name", "fullname"]) || "Website Lead";
    const email = pick(body, ["email"]);
    const phonenumber = pick(body, ["phone", "phone_number", "mobile", "phonenumber"]);
    const city = pick(body, ["city"]);

    let sourceDoc = await LeadSource.findOne({ name: form.name, tenant_id: form.tenant_id });
    if (!sourceDoc) {
      sourceDoc = await LeadSource.create({ name: form.name, tenant_id: form.tenant_id });
    }

    const statusDoc = await getDefaultLeadStatus(form.tenant_id);

    const lead = await Lead.create({
      name,
      email,
      phonenumber,
      city,
      tenant_id: form.tenant_id,
      source: sourceDoc._id,
      status: statusDoc._id,
      description: `Submitted via website form "${form.name}"`,
    });

    await saveExtraFieldsAsCustomFields(lead._id, body, form.name);

    form.total_leads += 1;
    form.last_lead_at = new Date();
    await form.save();

    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { listForms, createForm, deleteForm, receiveLead };
