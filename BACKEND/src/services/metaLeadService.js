const Lead = require("../models/Lead");
const LeadSource = require("../models/LeadSource");
const CustomField = require("../models/CustomField");
const CustomFieldService = require("./CustomFieldService");
const { getDefaultLeadStatus } = require("../utils/getDefaultLeadStatus");
const { slugForQuestionKey } = require("../utils/metaFieldSlug");

const parseFieldData = (fieldData) => {
  let email = "";
  let name = "";
  let phoneNumber = "";

  if (Array.isArray(fieldData)) {
    for (const field of fieldData) {
      const fieldName = field.name;
      const fieldValue = field.values ? field.values[0] : "";

      if (fieldName === "email") email = fieldValue;
      else if (fieldName === "full_name" || fieldName === "name") name = fieldValue;
      else if (fieldName === "phone_number" || fieldName === "phone") phoneNumber = fieldValue;
      else if (fieldName === "first_name" && !name) name = fieldValue;
      else if (fieldName === "last_name" && name) name += " " + fieldValue;
    }
  }

  if (!name) name = "Meta Lead";
  return { name, email, phoneNumber };
};

// Meta returns field_data as [{ name: <question key>, values: [<answer>] }, ...].
// Flattened into a plain { key: value } map so every answer survives, not
// just the ones parseFieldData() recognizes.
const flattenFieldData = (fieldData) => {
  const map = {};
  if (Array.isArray(fieldData)) {
    for (const field of fieldData) {
      if (field?.name) map[field.name] = field.values ? field.values[0] : "";
    }
  }
  return map;
};

// Turns every answer this lead gave into a real Leads-table column,
// automatically — no manual "pick which questions matter" step. Find-or-
// create a CustomField (fieldto: "leads") per question key, then write this
// lead's value into it. questionLabels (key -> label, from the form's cached
// `questions`) gives the column a human name; falls back to the raw key for
// forms that haven't been re-synced since this existed, so nothing is ever
// silently dropped even without a label.
const autoPromoteAnswers = async (leadId, fieldDataMap, questionLabels = {}) => {
  // Fields belong to the lead's company — never reuse or create another company's.
  const tenantId = (await Lead.findById(leadId).select("tenant_id").lean())?.tenant_id || null;
  const values = {};
  for (const [key, value] of Object.entries(fieldDataMap)) {
    const slug = slugForQuestionKey(key);
    let field = await CustomFieldService.findBySlug(slug, "leads", tenantId);
    if (!field) {
      const lastField = await CustomField.findOne({ fieldto: "leads", ...CustomFieldService.tenantScope(tenantId) }).sort("-field_order");
      field = await CustomField.create({
        name: questionLabels[key] || key,
        slug,
        fieldto: "leads",
        type: "input",
        show_on_table: true,
        field_order: (lastField?.field_order || 0) + 1,
        tenant_id: tenantId,
      });
    }
    values[slug] = value;
  }
  if (Object.keys(values).length > 0) {
    await CustomFieldService.handlePost(leadId, "leads", values, tenantId);
  }
};

// Creates the Lead if this leadgen_id hasn't been imported for this tenant yet.
// Returns { created, lead } — created=false means it was already present (dedup).
const upsertLeadFromMeta = async ({ tenantId, leadgenId, fieldData, formId, formName, questionLabels, createdTime, adId }) => {
  const existing = await Lead.findOne({ meta_leadgen_id: leadgenId, tenant_id: tenantId });
  if (existing) {
    return { created: false, lead: existing };
  }

  const { name, email, phoneNumber } = parseFieldData(fieldData);

  // One Source per specific ad/form (falling back to the generic "Meta Ads"
  // bucket only if a form somehow has no name) so Source-based filtering and
  // reports reflect which ad actually produced the lead, not just "Meta Ads"
  // for everything.
  const sourceName = formName || "Meta Ads";
  let sourceDoc = await LeadSource.findOne({ name: sourceName, tenant_id: tenantId });
  if (!sourceDoc) {
    sourceDoc = await LeadSource.create({ name: sourceName, tenant_id: tenantId });
  }

  const statusDoc = await getDefaultLeadStatus(tenantId);
  const fieldDataMap = flattenFieldData(fieldData);

  // Meta's own created_time is when the person actually submitted the form —
  // use it for dateadded/createdAt instead of whenever our webhook/import
  // happened to process it, so the CRM's date/time matches Meta's Leads
  // Center/export for the same lead. Falls back to "now" if Meta didn't
  // return it (shouldn't happen, but avoids an invalid date on the doc).
  const submittedAt = createdTime ? new Date(createdTime) : undefined;

  const lead = await Lead.create({
    name,
    email,
    phonenumber: phoneNumber,
    tenant_id: tenantId,
    source: sourceDoc._id,
    status: statusDoc._id,
    meta_leadgen_id: leadgenId,
    meta_form_id: formId,
    meta_form_name: formName,
    meta_field_data: fieldDataMap,
    ...(adId ? { meta_ad_id: String(adId) } : {}),
    description: `Generated from Meta Ads (Lead ID: ${leadgenId})`,
    ...(submittedAt && !isNaN(submittedAt.getTime())
      ? { dateadded: submittedAt, createdAt: submittedAt }
      : {}),
  });

  await autoPromoteAnswers(lead._id, fieldDataMap, questionLabels);

  // Best-effort campaign tagging via the tenant's connected Meta ad account
  // (for cost-per-lead per campaign); never blocks or fails lead creation.
  if (adId) {
    const { resolveCampaignForAd } = require("./metaAdsService");
    resolveCampaignForAd(tenantId, String(adId))
      .then((name) => (name ? Lead.updateOne({ _id: lead._id, campaign: { $in: [null, ""] } }, { campaign: name }) : null))
      .catch((err) => console.error("[Meta Leads] campaign lookup failed:", err.message));
  }

  return { created: true, lead };
};

module.exports = { parseFieldData, flattenFieldData, autoPromoteAnswers, upsertLeadFromMeta };
