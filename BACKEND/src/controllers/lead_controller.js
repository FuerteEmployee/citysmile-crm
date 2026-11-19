const Lead = require("../models/Lead");
const LeadStatus = require("../models/LeadStatus");
const LeadSource = require("../models/LeadSource");
const Staff = require("../models/Staff");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");
const { readSettings, isOn, isAdminUser } = require("../utils/tenantSettings");

// Setup > Settings > Leads as the backend uses it.
const getLeadSettings = async (tenantId) => {
  const v = await readSettings(tenantId, ["leadAllowNonAdminImport", "leadLockAfterConvert", "leadAutoAssignAdmin", "leadDuplicateFields"]);
  let dup = v.leadDuplicateFields;
  if (typeof dup === "string") {
    try { dup = JSON.parse(dup); } catch { dup = dup.split(","); }
  }
  return {
    allowNonAdminImport: isOn(v.leadAllowNonAdminImport),
    lockAfterConvert: isOn(v.leadLockAfterConvert),
    autoAssignAdmin: isOn(v.leadAutoAssignAdmin),
    duplicateFields: (Array.isArray(dup) ? dup : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean),
  };
};
// "Do not allow leads to be edited after they are converted to customers (administrators not applied)".
const lockedMessage = "This lead is already converted to a customer and can no longer be edited (Setup > Settings > Leads).";
const isLockedForUser = async (req, lead) =>
  !!lead?.converted && !isAdminUser(req.user) && (await getLeadSettings(lead.tenant_id)).lockAfterConvert;
// "Auto assign as admin to customer after convert": the lead's assignee (else the converting staff).
const customerAdminsFor = async (tenantId, lead, req) => {
  if (!(await getLeadSettings(tenantId)).autoAssignAdmin) return undefined;
  const staff = lead.assigned || req.user?._id;
  return staff ? [{ staff, date_assigned: new Date() }] : undefined;
};
const { applyOwnScope, tenantFilter } = require("../services/leadScope");
const { reminderLeadIds, attachLeadInsights, whatsappLeadCondition } = require("../services/leadInsightsService");

// Owned by the convert endpoint / WhatsApp integration — a generic create or
// update payload must never set these (e.g. to fake a conversion).
const PROTECTED_LEAD_FIELDS = [
  "_id",
  "tenant_id",
  "converted",
  "converted_at",
  "client_id",
  "origin",
  "phone_last10",
  "meta_ad_id",
  "whatsapp_wa_id",
  "whatsapp_first_message",
  "whatsapp_last_message",
  "whatsapp_last_message_at",
  "whatsapp_message_count",
  "createdAt",
  "updatedAt",
];
const stripProtected = (data) => {
  for (const key of PROTECTED_LEAD_FIELDS) delete data[key];
  return data;
};

const enrichLeads = async (leads) => {
  const cfByLead = await CustomFieldService.getValuesForMany(leads.map((l) => l._id), "leads");
  return leads.map((lead) => {
    const leadObj = lead.toObject();
    leadObj.custom_fields = cfByLead.get(String(lead._id)) || {};
    return leadObj;
  });
};

const getLeads = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    applyOwnScope(req, filter);

    const {
      page, limit, search, status, metaForm, dateFrom, dateTo,
      source, assigned, campaign, whatsapp, converted, reminder,
    } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (dashboard/report aggregation, the ProposalCreate lead picker) keep
    // getting the full bare array exactly as before.
    if (!isPaginated) {
      const leads = await Lead.find(filter).populate("status").populate("source");
      const enriched = await enrichLeads(leads);
      // Opt-in (Leads page "All" mode) so dashboard/report callers are unchanged.
      if (req.query.insights === "1") return res.json(await attachLeadInsights(enriched, tenantFilter(req)));
      return res.json(enriched);
    }

    // Per-status counts (the clickable status cards) always reflect the
    // whole tenant/own-scope, independent of the currently active search/
    // status/metaForm/date filters — matches prior behavior (computed from
    // the full, unfiltered leads list).
    const baseFilter = { ...filter };

    // `applyOwnScope` may already have set filter.$or for permission scoping
    // — combine it with the search $or via $and instead of overwriting it.
    const andConditions = [];
    if (filter.$or) {
      andConditions.push({ $or: filter.$or });
      delete filter.$or;
    }
    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");

      // Status/Source/Assigned are shown in the table by name, but stored as
      // refs — resolve which ones match the search text (scoped to the same
      // tenant) so those columns are searchable too, not just plain-string fields.
      const refScope = req.user?.is_superadmin ? {} : { tenant_id: req.user?.tenant_id };
      const [matchedStatusIds, matchedSourceIds, matchedStaffIds] = await Promise.all([
        LeadStatus.find({ ...refScope, name: re }).distinct("_id"),
        LeadSource.find({ ...refScope, name: re }).distinct("_id"),
        Staff.find({ ...refScope, $or: [{ firstname: re }, { lastname: re }] }).distinct("_id"),
      ]);

      andConditions.push({
        $or: [
          { name: re },
          { company: re },
          { email: re },
          { phonenumber: re },
          { tags: re },
          { lead_value: re },
          { salesPerson: re },
          { branch: re },
          { status: { $in: matchedStatusIds } },
          { source: { $in: matchedSourceIds } },
          { assigned: { $in: matchedStaffIds } },
        ],
      });
    }
    const mongoose = require("mongoose");
    const isId = (v) => v && mongoose.Types.ObjectId.isValid(v);

    if (whatsapp === "1" || whatsapp === "true") {
      andConditions.push(await whatsappLeadCondition(req));
    }
    if (andConditions.length) filter.$and = andConditions;

    if (status && status !== "all" && isId(status)) filter.status = status;
    if (metaForm && metaForm !== "all") filter.meta_form_id = metaForm;
    if (source && source !== "all" && isId(source)) filter.source = source;
    if (assigned === "unassigned") filter.assigned = null;
    else if (assigned && assigned !== "all" && isId(assigned)) filter.assigned = assigned;
    if (campaign && campaign !== "all") filter.campaign = String(campaign);
    if (converted === "yes") filter.converted = true;
    else if (converted === "no") filter.converted = { $ne: true };
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }
    if (reminder && reminder !== "all") {
      if (reminder === "none") {
        filter._id = { $nin: await reminderLeadIds(req, "any") };
      } else if (["today", "overdue", "upcoming", "any"].includes(reminder)) {
        filter._id = { $in: await reminderLeadIds(req, reminder) };
      }
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    const [total, statusAgg, leads] = await Promise.all([
      Lead.countDocuments(filter),
      Lead.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Lead.find(filter)
        .populate("status")
        .populate("source")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await attachLeadInsights(await enrichLeads(leads), tenantFilter(req)),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      statusCounts: statusAgg.map((s) => ({ status: s._id ? String(s._id) : null, count: s.count })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getLeadById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOne(query)
      .populate("status")
      .populate("source")
      .populate("assigned", "firstname lastname");
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const leadObj = lead.toObject();
    leadObj.custom_fields = await CustomFieldService.getValues(lead._id, "leads");
    res.json(leadObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLead = async (req, res) => {
  try {
    const { custom_fields, ...leadData } = req.body;
    stripProtected(leadData);

    // Sanitize empty object IDs to prevent CastErrors
    const mongoose = require('mongoose');
    const validateId = (val) => val && mongoose.Types.ObjectId.isValid(val);
    
    if (!validateId(leadData.status)) delete leadData.status;
    if (!validateId(leadData.source)) delete leadData.source;
    if (!validateId(leadData.assigned)) delete leadData.assigned;
    // Default to the creating staff member so leads they add stay visible
    // to them under "own" scope even when assigned to someone else.
    if (!validateId(leadData.addedfrom)) leadData.addedfrom = req.user?._id;

    // "Perform validation for duplicate lead on the following fields".
    const { duplicateFields } = await getLeadSettings(req.user?.tenant_id);
    const dupChecks = [];
    const escape = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (duplicateFields.includes("email") && String(leadData.email || "").trim()) dupChecks.push({ email: new RegExp(`^${escape(leadData.email)}$`, "i") });
    if (duplicateFields.includes("phone") && String(leadData.phonenumber || "").trim()) dupChecks.push({ phonenumber: String(leadData.phonenumber).trim() });
    if (duplicateFields.includes("company") && String(leadData.company || "").trim()) dupChecks.push({ company: new RegExp(`^${escape(leadData.company)}$`, "i") });
    if (duplicateFields.includes("website") && String(leadData.website || "").trim()) dupChecks.push({ website: new RegExp(`^${escape(leadData.website)}$`, "i") });
    if (dupChecks.length) {
      const existing = await Lead.findOne({ tenant_id: req.user?.tenant_id, $or: dupChecks }).select("name company email phonenumber");
      if (existing) {
        return res.status(409).json({ message: `A lead with the same details already exists: ${existing.name || existing.company || existing.email || existing.phonenumber} (Setup > Settings > Leads > duplicate validation).` });
      }
    }

    // Create the lead with all the provided data
    const lead = await Lead.create({ ...leadData, tenant_id: req.user?.tenant_id });

    if (lead) {
      if (custom_fields) {
        await CustomFieldService.handlePost(lead._id, "leads", custom_fields, lead.tenant_id);
      }
      logActivity(req, `Created lead: ${lead.name || lead.company || lead._id}`, { rel_id: lead._id, rel_type: "lead" });
      res.status(201).json(lead);
    } else {
      res.status(400).json({ message: "Invalid lead data" });
    }
  } catch (error) {
    console.error("CREATE LEAD ERROR:", error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: error.message, stack: error.stack });
  }
};

const updateLead = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOne(query);
    if (lead && (await isLockedForUser(req, lead))) return res.status(403).json({ message: lockedMessage });
    if (lead) {
      const updateData = stripProtected({ ...req.body });
      const mongoose = require('mongoose');
      const validateId = (val) => val && mongoose.Types.ObjectId.isValid(val);

      if (!validateId(updateData.status)) delete updateData.status;
      if (!validateId(updateData.source)) delete updateData.source;
      if (!validateId(updateData.assigned)) delete updateData.assigned;
      if (!validateId(updateData.addedfrom)) delete updateData.addedfrom;

      // Re-arm the follow-up notification whenever the date is changed
      if (updateData.followup_date !== undefined) {
        updateData.followup_notified = false;
      }

      Object.assign(lead, updateData);
      const updatedLead = await lead.save();
      logActivity(req, `Updated lead: ${updatedLead.name || updatedLead.company || updatedLead._id}`, { rel_id: updatedLead._id, rel_type: "lead" });
      res.json(updatedLead);
    } else {
      res.status(404).json({ message: "Lead not found" });
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Another WhatsApp lead already uses this phone number" });
    }
    res.status(500).json({ message: error.message });
  }
};

const updateLeadStatus = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.body.status)) {
      return res.status(400).json({ message: "A valid status id is required" });
    }
    const statusQuery = { _id: req.body.status };
    if (!req.user?.is_superadmin) statusQuery.tenant_id = req.user?.tenant_id;
    const statusExists = await LeadStatus.findOne(statusQuery);
    if (!statusExists) {
      return res.status(400).json({ message: "Status not found for this tenant" });
    }

    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOne(query);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (await isLockedForUser(req, lead)) return res.status(403).json({ message: lockedMessage });

    lead.status = req.body.status;
    const updatedLead = await lead.save();
    logActivity(req, `Moved lead: ${updatedLead.name || updatedLead.company || updatedLead._id} to a new status`, { rel_id: updatedLead._id, rel_type: "lead" });
    res.json(updatedLead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteLead = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOne(query);
    if (lead) {
      const leadName = lead.name || lead.company || lead._id;
      await lead.deleteOne();
      logActivity(req, `Deleted lead: ${leadName}`, { rel_type: "lead" });
      res.json({ message: "Lead removed" });
    } else {
      res.status(404).json({ message: "Lead not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// lead from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large lead lists.
const bulkDeleteLeads = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No lead ids provided" });

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);

    const result = await Lead.deleteMany(query);
    logActivity(req, `Bulk-deleted ${result.deletedCount} lead(s)`, { rel_type: "lead" });
    res.json({ message: `Deleted ${result.deletedCount} lead(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const importLeads = async (req, res) => {
  try {
    // "Allow non-admin staff members to import leads".
    if (!isAdminUser(req.user) && !(await getLeadSettings(req.user?.tenant_id)).allowNonAdminImport) {
      return res.status(403).json({ message: "Only administrators can import leads (Setup > Settings > Leads)." });
    }
    const leadsData = Array.isArray(req.body) ? req.body : req.body.leads;
    if (!leadsData || !Array.isArray(leadsData) || leadsData.length === 0) {
      return res.status(400).json({ message: "No valid lead data provided" });
    }

    const mongoose = require('mongoose');
    const validateId = (val) => val && mongoose.Types.ObjectId.isValid(val);
    const tenantId = req.user?.tenant_id;
    console.log("[importLeads] user tenant_id:", tenantId, "| rows to import:", leadsData.length);

    const tenantFilter = tenantId ? { tenant_id: tenantId } : {};

    // Fetch statuses and sources for mapping names to ObjectIds
    const statuses = await LeadStatus.find(tenantFilter);
    const sources = await LeadSource.find(tenantFilter);
    const statusMap = new Map(statuses.map(s => [s.name.toLowerCase().trim(), s._id]));
    const sourceMap = new Map(sources.map(s => [s.name.toLowerCase().trim(), s._id]));

    // Sanitize all incoming rows
    const sanitizedLeads = leadsData.map(lead => {
      const sanitized = { ...stripProtected({ ...lead }), tenant_id: tenantId };

      if (sanitized.status) {
        if (!validateId(sanitized.status)) {
          const mappedId = statusMap.get(String(sanitized.status).toLowerCase().trim());
          if (mappedId) sanitized.status = mappedId;
          else delete sanitized.status;
        }
      }
      
      if (sanitized.source) {
        if (!validateId(sanitized.source)) {
          const mappedId = sourceMap.get(String(sanitized.source).toLowerCase().trim());
          if (mappedId) sanitized.source = mappedId;
          else delete sanitized.source;
        }
      }

      if (!validateId(sanitized.assigned)) delete sanitized.assigned;
      if (!validateId(sanitized.addedfrom)) delete sanitized.addedfrom;
      return sanitized;
    });

    // Collect emails and names from incoming leads for duplicate check
    const incomingEmails = sanitizedLeads
      .map(l => l.email?.trim().toLowerCase())
      .filter(Boolean);
    const incomingNames = sanitizedLeads.map(l => (l.name || "").trim().toLowerCase());

    // Find already-existing leads for this tenant that match by email OR name
    const existing = await Lead.find({
      ...tenantFilter,
      $or: [
        ...(incomingEmails.length ? [{ email: { $in: incomingEmails } }] : []),
        { name: { $in: sanitizedLeads.map(l => new RegExp(`^${l.name.trim()}$`, "i")) } },
      ],
    }).select("email name");

    const existingEmails = new Set(existing.map(l => l.email?.trim().toLowerCase()).filter(Boolean));
    const existingNames  = new Set(existing.map(l => l.name?.trim().toLowerCase()).filter(Boolean));

    // Keep only leads that don't already exist
    const newLeads = sanitizedLeads.filter(l => {
      const email = l.email?.trim().toLowerCase();
      const name  = l.name?.trim().toLowerCase();
      if (email && existingEmails.has(email)) return false;
      if (name  && existingNames.has(name))   return false;
      return true;
    });

    const skipped = sanitizedLeads.length - newLeads.length;
    console.log("[importLeads] new:", newLeads.length, "| skipped (already exist):", skipped);

    if (newLeads.length === 0) {
      return res.status(200).json({
        message: `All ${sanitizedLeads.length} lead(s) already exist — nothing imported.`,
        count: 0,
        skipped,
      });
    }

    const result = await Lead.insertMany(newLeads, { ordered: false });
    console.log("[importLeads] inserted:", result.length);
    res.status(201).json({
      message: `Imported ${result.length} new lead(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}.`,
      count: result.length,
      skipped,
    });
  } catch (error) {
    console.error("IMPORT LEADS ERROR:", error);
    if (error.code === 11000) {
      return res.status(207).json({ message: "Partial import completed, some duplicates skipped." });
    }
    res.status(500).json({ message: error.message });
  }
};

// Converts a lead into a patient (Client) and records the treatment business
// it produced as a LeadConversion. Body: { treatment_item?, treatment_name,
// treatment_amount, notes?, converted_at? }.
const convertToCustomer = async (req, res) => {
  const mongoose = require("mongoose");
  const Client = require("../models/Client");
  const Contact = require("../models/Contact");
  const Item = require("../models/Item");
  const LeadConversion = require("../models/LeadConversion");
  const { toE164 } = require("../utils/phoneNormalize");
  const { getConvertedStatus } = require("../services/leadInsightsService");

  const { tenantHasFeature } = require("../utils/tenantFeatures");

  let createdClientId = null;
  try {
    const tenantId = req.user?.tenant_id;
    // Without the patient_conversion feature this stays the original simple
    // "convert to customer": no treatment fields, no LeadConversion record.
    const trackTreatment = !!req.user?.is_superadmin || (await tenantHasFeature(tenantId, "patient_conversion"));
    const { treatment_item, notes } = req.body || {};
    let treatmentName = String(req.body?.treatment_name || "").trim();
    const amount = Number(req.body?.treatment_amount);

    if (trackTreatment && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ message: "treatment_amount must be a number of 0 or more" });
    }
    if (trackTreatment && amount > 100000000) {
      return res.status(400).json({ message: "treatment_amount is unrealistically large" });
    }

    let convertedAt = new Date();
    if (req.body?.converted_at) {
      convertedAt = new Date(req.body.converted_at);
      if (isNaN(convertedAt.getTime()) || convertedAt.getTime() > Date.now() + 60 * 1000) {
        return res.status(400).json({ message: "converted_at must be a valid date that is not in the future" });
      }
    }

    let item = null;
    if (trackTreatment && treatment_item) {
      if (!mongoose.Types.ObjectId.isValid(treatment_item)) {
        return res.status(400).json({ message: "Invalid treatment_item" });
      }
      item = await Item.findOne({ _id: treatment_item, ...tenantFilter(req) }).select("name");
      if (!item) return res.status(400).json({ message: "Selected treatment was not found" });
      if (!treatmentName) treatmentName = item.name;
    }
    if (trackTreatment && !treatmentName) {
      return res.status(400).json({ message: "Select a treatment or enter a treatment name" });
    }

    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = tenantId;
    applyOwnScope(req, query);
    const lead = await Lead.findOne(query).populate("source", "name");
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.converted) {
      return res.status(409).json({ message: "This lead has already been converted" });
    }

    // Reuse the existing patient with the same phone number instead of
    // creating a duplicate Client.
    let client = null;
    const phoneE164 = lead.phonenumber ? toE164(lead.phonenumber) : null;
    if (phoneE164) client = await Client.findOne({ tenant_id: tenantId, phoneE164 });

    if (!client) {
      client = await Client.create({
        company:          lead.company || lead.name,
        phonenumber:      lead.phonenumber || "",
        email:            lead.email || "",
        website:          lead.website || "",
        address:          lead.address || "",
        city:             lead.city || "",
        state:            lead.state || "",
        zip:              lead.zip || "",
        country:          lead.country || "",
        default_language: lead.default_language || "English",
        tenant_id:        tenantId,
        created_by:       req.user?._id,
        active:           true,
        admins:           await customerAdminsFor(tenantId, lead, req),
      });
      createdClientId = client._id;

      // Primary contact — non-critical, never blocks conversion success
      if (lead.email) {
        try {
          const nameParts = (lead.name || "").trim().split(" ");
          await Contact.create({
            userid:      client._id,
            is_primary:  true,
            firstname:   nameParts[0] || "Contact",
            lastname:    nameParts.slice(1).join(" ").trim() || "-",
            email:       lead.email.trim().toLowerCase(),
            phonenumber: lead.phonenumber || "",
            title:       lead.title || "",
          });
        } catch (contactErr) {
          console.warn("Contact creation skipped during lead conversion:", contactErr.message);
        }
      }
    }

    if (!trackTreatment) {
      // Legacy conversion: move to an existing Customer/Converted status if
      // the tenant has one, never invent a new status.
      const customerStatus = await LeadStatus.findOne({
        name: { $regex: /^(customer|converted)$/i },
        ...(tenantId ? { tenant_id: tenantId } : {}),
      });
      await Lead.updateOne(
        { _id: lead._id },
        {
          ...(customerStatus ? { status: customerStatus._id } : {}),
          converted: true,
          converted_at: new Date(),
          client_id: client._id,
          lost: false,
          junk: false,
        }
      );
      logActivity(req, `Converted lead to customer: ${lead.name}`, { rel_id: lead._id, rel_type: "lead" });
      return res.status(201).json({ client, message: "Lead converted to customer successfully" });
    }

    let conversion;
    try {
      conversion = await LeadConversion.create({
        tenant_id: tenantId,
        lead: lead._id,
        client: client._id,
        converted_at: convertedAt,
        converted_by: req.user?._id,
        treatment_item: item?._id,
        treatment_name: treatmentName.slice(0, 200),
        treatment_amount: Math.round(amount * 100) / 100,
        source: lead.source?._id,
        source_name: lead.source?.name || "",
        campaign: lead.campaign || lead.meta_form_name || "",
        is_whatsapp: lead.origin === "whatsapp" || /^whatsapp$/i.test(lead.source?.name || ""),
        assigned: lead.assigned,
        notes: String(notes || "").slice(0, 2000),
      });
    } catch (convErr) {
      // A concurrent request already converted this lead.
      if (convErr.code === 11000) {
        if (createdClientId) await Client.deleteOne({ _id: createdClientId }).catch(() => {});
        return res.status(409).json({ message: "This lead has already been converted" });
      }
      throw convErr;
    }
    // The conversion now references the client — never roll it back past here.
    createdClientId = null;

    const convertedStatus = await getConvertedStatus(tenantId);
    await Lead.updateOne(
      { _id: lead._id },
      {
        status: convertedStatus._id,
        converted: true,
        converted_at: convertedAt,
        client_id: client._id,
        lost: false,
        junk: false,
      }
    );

    logActivity(
      req,
      `Converted lead to patient: ${lead.name} — ${treatmentName} (${conversion.treatment_amount})`,
      { rel_id: lead._id, rel_type: "lead" }
    );

    res.status(201).json({ client, conversion, message: "Lead converted to patient successfully" });
  } catch (error) {
    if (createdClientId) {
      require("../models/Client").deleteOne({ _id: createdClientId }).catch(() => {});
    }
    console.error("CONVERT TO CUSTOMER ERROR:", error);
    if (error.name === "ValidationError") return res.status(400).json({ message: error.message });
    res.status(500).json({ message: error.message });
  }
};

const markAsLost = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOneAndUpdate(
      query,
      { lost: true, junk: false },
      { new: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ message: "Lead marked as lost", lead });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const markAsJunk = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    applyOwnScope(req, query);
    const lead = await Lead.findOneAndUpdate(
      query,
      { junk: true, lost: false },
      { new: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ message: "Lead marked as junk", lead });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkConvertToCustomer = async (req, res) => {
  const mongoose = require("mongoose");
  const Client = require("../models/Client");
  const Contact = require("../models/Contact");
  const LeadConversion = require("../models/LeadConversion");
  const { toE164 } = require("../utils/phoneNormalize");
  const { getConvertedStatus } = require("../services/leadInsightsService");
  const { tenantHasFeature } = require("../utils/tenantFeatures");

  try {
    const rawIds = Array.isArray(req.body?.ids)
      ? req.body.ids
      : Array.isArray(req.body?.lead_ids)
      ? req.body.lead_ids
      : [];
    const ids = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (ids.length === 0) {
      return res.status(400).json({ message: "No valid lead ids provided" });
    }

    const tenantId = req.user?.tenant_id;
    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin && tenantId) query.tenant_id = tenantId;
    applyOwnScope(req, query);

    const leads = await Lead.find(query).populate("source", "name");
    if (!leads || leads.length === 0) {
      return res.status(404).json({ message: "No matching leads found" });
    }

    const trackTreatment =
      !!req.user?.is_superadmin || (await tenantHasFeature(tenantId, "patient_conversion"));
    const convertedStatus = await getConvertedStatus(tenantId);

    let convertedCount = 0;
    let skippedCount = 0;
    const convertedClients = [];

    for (const lead of leads) {
      if (lead.converted) {
        skippedCount++;
        continue;
      }

      try {
        let client = null;
        const phoneE164 = lead.phonenumber ? toE164(lead.phonenumber) : null;
        if (phoneE164 && tenantId) {
          client = await Client.findOne({ tenant_id: tenantId, phoneE164 });
        }

        if (!client) {
          client = await Client.create({
            company:          lead.company || lead.name || "Customer",
            contact_person:   lead.name || "",
            phonenumber:      lead.phonenumber || "",
            email:            lead.email || "",
            website:          lead.website || "",
            address:          lead.address || "",
            city:             lead.city || "",
            state:            lead.state || "",
            zip:              lead.zip || "",
            country:          lead.country || "",
            billing_street:   lead.address || "",
            billing_city:     lead.city || "",
            billing_state:    lead.state || "",
            billing_zip:      lead.zip || "",
            billing_country:  lead.country || "",
            shipping_street:  lead.address || "",
            shipping_city:    lead.city || "",
            shipping_state:   lead.state || "",
            shipping_zip:     lead.zip || "",
            shipping_country: lead.country || "",
            default_language: lead.default_language || "English",
            sales_person:     lead.assigned || null,
            tenant_id:        tenantId,
            created_by:       req.user?._id,
            active:           true,
            admins:           await customerAdminsFor(tenantId, lead, req),
          });

          if (lead.email) {
            try {
              const nameParts = (lead.name || "").trim().split(" ");
              await Contact.create({
                userid:      client._id,
                is_primary:  true,
                firstname:   nameParts[0] || "Contact",
                lastname:    nameParts.slice(1).join(" ").trim() || "-",
                email:       lead.email.trim().toLowerCase(),
                phonenumber: lead.phonenumber || "",
                title:       lead.title || "",
              });
            } catch (contactErr) {
              console.warn("Contact creation skipped during bulk conversion:", contactErr.message);
            }
          }
        } else {
          // Client already exists — fill in missing address/contact fields from lead
          let updated = false;
          if (!client.email && lead.email) { client.email = lead.email; updated = true; }
          if (!client.website && lead.website) { client.website = lead.website; updated = true; }
          if (!client.address && lead.address) {
            client.address = lead.address;
            if (!client.billing_street) client.billing_street = lead.address;
            updated = true;
          }
          if (!client.city && lead.city) {
            client.city = lead.city;
            if (!client.billing_city) client.billing_city = lead.city;
            updated = true;
          }
          if (!client.state && lead.state) {
            client.state = lead.state;
            if (!client.billing_state) client.billing_state = lead.state;
            updated = true;
          }
          if (!client.zip && lead.zip) {
            client.zip = lead.zip;
            if (!client.billing_zip) client.billing_zip = lead.zip;
            updated = true;
          }
          if (!client.country && lead.country) {
            client.country = lead.country;
            if (!client.billing_country) client.billing_country = lead.country;
            updated = true;
          }
          if (!client.sales_person && lead.assigned) {
            client.sales_person = lead.assigned;
            updated = true;
          }
          if (updated) await client.save();
        }

        if (trackTreatment) {
          try {
            await LeadConversion.create({
              tenant_id: tenantId,
              lead: lead._id,
              client: client._id,
              converted_at: new Date(),
              converted_by: req.user?._id,
              treatment_name: "Bulk Converted",
              treatment_amount: Number(lead.lead_value) || 0,
              source: lead.source?._id,
              source_name: lead.source?.name || "",
              campaign: lead.campaign || lead.meta_form_name || "",
              is_whatsapp: lead.origin === "whatsapp" || /^whatsapp$/i.test(lead.source?.name || ""),
              assigned: lead.assigned,
              notes: "Bulk conversion to customer",
            });
          } catch (convErr) {
            if (convErr.code !== 11000) {
              console.warn("Bulk LeadConversion record warning:", convErr.message);
            }
          }
        }

        await Lead.updateOne(
          { _id: lead._id },
          {
            ...(convertedStatus ? { status: convertedStatus._id } : {}),
            converted: true,
            converted_at: new Date(),
            client_id: client._id,
            lost: false,
            junk: false,
          }
        );

        convertedCount++;
        convertedClients.push({ leadId: lead._id, clientId: client._id });
        logActivity(req, `Converted lead to customer via bulk action: ${lead.name}`, { rel_id: lead._id, rel_type: "lead" });
      } catch (itemErr) {
        console.error(`Error converting lead ${lead._id}:`, itemErr);
      }
    }

    logActivity(req, `Bulk converted ${convertedCount} lead(s) to customer(s)`, { rel_type: "lead" });

    return res.status(200).json({
      success: true,
      message: `Successfully converted ${convertedCount} lead(s) to customer(s)${skippedCount > 0 ? ` (${skippedCount} already converted)` : ""}.`,
      convertedCount,
      skippedCount,
      convertedClients,
    });
  } catch (error) {
    console.error("BULK CONVERT TO CUSTOMER ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getLeads, getLeadById, createLead, updateLead, updateLeadStatus, deleteLead, importLeads, convertToCustomer, markAsLost, markAsJunk, bulkDeleteLeads, bulkConvertToCustomer };
