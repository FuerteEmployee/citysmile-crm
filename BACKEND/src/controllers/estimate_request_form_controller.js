const EstimateRequestForm = require("../models/EstimateRequestForm");
const Estimate = require("../models/Estimate");
const EstimateRequest = require("../models/EstimateRequest");
const HRMSBranch = require("../hrms/models/hrms_branch_model");

// Scope a query to the requesting admin's tenant, while still matching forms
// saved before tenant scoping existed (no tenant_id) so pre-existing data
// doesn't silently disappear. Superadmins and unauthenticated (public route)
// requests are left unfiltered.
const withTenantFilter = (req, base = {}) => {
  if (req.user && !req.user.is_superadmin && req.user.tenant_id) {
    return { ...base, $or: [{ tenant_id: req.user.tenant_id }, { tenant_id: { $exists: false } }, { tenant_id: null }] };
  }
  return base;
};

// @desc    Get all estimate request forms
// @route   GET /api/estimate-request-forms
// @access  Private
exports.getForms = async (req, res) => {
  try {
    const forms = await EstimateRequestForm.find(withTenantFilter(req))
      .populate("status")
      .populate("responsible", "firstname lastname")
      .populate("notifications.staff_to_notify", "firstname lastname")
      .populate("notifications.roles_to_notify", "name");

    const formIds = forms.map((form) => form._id);
    const submissionCounts = await EstimateRequest.aggregate([
      { $match: { form: { $in: formIds } } },
      { $group: { _id: "$form", count: { $sum: 1 } } },
    ]);
    const countByForm = new Map(submissionCounts.map((c) => [String(c._id), c.count]));

    const formsWithCounts = forms.map((form) => ({
      ...form.toObject(),
      totalSubmissions: countByForm.get(String(form._id)) || 0,
    }));

    res.json(formsWithCounts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single form
// @route   GET /api/estimate-request-forms/:id
// @access  Private
exports.getFormById = async (req, res) => {
  try {
    // req.user is only present on the authenticated route (mounted after
    // `protect`); the public share-link route (`/public/:id`) has no user
    // and must stay accessible to anyone regardless of tenant.
    const form = await EstimateRequestForm.findOne(withTenantFilter(req, { _id: req.params.id }))
      .populate("status")
      .populate("responsible", "firstname lastname")
      .populate("notifications.staff_to_notify", "firstname lastname")
      .populate("notifications.roles_to_notify", "name");
    if (!form) return res.status(404).json({ message: "Form not found" });

    const formObj = form.toObject();
    // The public form renderer has no auth, so it can't call the protected
    // /hrms-branches endpoint itself — attach the tenant's active branches
    // here whenever the form has a "branch" field that needs them as options.
    if (form.fields.some((f) => f.type === "branch")) {
      formObj.branches = await HRMSBranch.find({
        tenant_id: form.tenant_id || null,
        status: "Active",
      })
        .select("name")
        .sort("name")
        .lean();
    }

    res.json(formObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a form
// @route   POST /api/estimate-request-forms
// @access  Private
exports.createForm = async (req, res) => {
  try {
    const form = new EstimateRequestForm({ ...req.body, tenant_id: req.user?.tenant_id });
    const savedForm = await form.save();
    res.status(201).json(savedForm);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update a form
// @route   PUT /api/estimate-request-forms/:id
// @access  Private
exports.updateForm = async (req, res) => {
  try {
    const updatedForm = await EstimateRequestForm.findOneAndUpdate(
      withTenantFilter(req, { _id: req.params.id }),
      req.body,
      { new: true }
    );
    if (!updatedForm) return res.status(404).json({ message: "Form not found" });
    res.json(updatedForm);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a form
// @route   DELETE /api/estimate-request-forms/:id
// @access  Private
exports.deleteForm = async (req, res) => {
  try {
    const form = await EstimateRequestForm.findOneAndDelete(withTenantFilter(req, { _id: req.params.id }));
    if (!form) return res.status(404).json({ message: "Form not found" });
    res.json({ message: "Form deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit public form — validates required fields, stores as Estimate
// @route   POST /api/estimate-request-forms/public/:id/submit
// @access  Public
exports.submitForm = async (req, res) => {
  try {
    const form = await EstimateRequestForm.findById(req.params.id);
    if (!form) return res.status(404).json({ message: "Form not found" });

    const body = req.body || {};

    // ── 1. Validate required fields defined on the form ───────────────────
    const missingFields = [];
    for (const field of form.fields) {
      if (["header", "paragraph"].includes(field.type)) continue;
      if (!field.required) continue;
      const val = body[field.name];
      const isEmpty =
        val === undefined ||
        val === null ||
        (typeof val === "string" && val.trim() === "") ||
        (Array.isArray(val) && val.length === 0);
      if (isEmpty) missingFields.push(field.label || field.name);
    }
    if (missingFields.length > 0) {
      return res.status(422).json({
        message: `Please fill in all required fields: ${missingFields.join(", ")}`,
        missing: missingFields,
      });
    }

    // ── 2. Extract common contact fields from submission ──────────────────
    const pick = (...keys) => {
      for (const key of keys) {
        if (body[key] && String(body[key]).trim()) return String(body[key]).trim();
      }
      // Also search by field label or type
      for (const field of form.fields) {
        if (
          keys.includes(field.type) ||
          keys.some((k) => field.label?.toLowerCase().includes(k))
        ) {
          if (body[field.name] && String(body[field.name]).trim())
            return String(body[field.name]).trim();
        }
      }
      return undefined;
    };

    const contactName = pick("name", "fullname", "full_name", "firstname", "first_name", "contact_name") || "New Estimate Request";
    const contactEmail = pick("email", "email_address");
    const contactPhone = pick("phone", "phonenumber", "mobile", "phone_number");
    const company = pick("company", "organization", "business_name");
    const firstname = pick("firstname", "first_name", "fname");
    const lastname = pick("lastname", "last_name", "lname");

    // ── 3. Build structured form_data ───────────
    const formData = [];
    for (const field of form.fields) {
      if (["header", "paragraph"].includes(field.type)) continue;
      const val = body[field.name];
      if (val !== undefined && val !== null) {
        formData.push({
          label: field.label,
          name: field.name,
          value: val,
          type: field.type,
        });
      }
    }

    // ── 4. Save as EstimateRequest record ────────────────────────────────────────
    const estimateRequest = await EstimateRequest.create({
      form: form._id,
      status: form.status, // Default status from form config
      assigned: form.responsible || undefined,
      firstname,
      lastname,
      email: contactEmail,
      phone: contactPhone,
      company,
      form_data: formData,
      date: new Date(),
    });

    res.json({
      message: "Form submitted successfully",
      id: estimateRequest._id,
    });
  } catch (error) {
    console.error("submitForm error:", error);
    res.status(400).json({ message: error.message });
  }
};
