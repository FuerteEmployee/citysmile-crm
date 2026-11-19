// One-time backfill for leads imported from Meta Lead Ads BEFORE
// meta_form_id/meta_form_name/meta_field_data existed on the Lead schema.
//
// upsertLeadFromMeta() dedupes by meta_leadgen_id and returns immediately for
// leads that already exist, so simply re-running "Import All" never touches
// these fields on already-imported leads — they stay permanently blank
// without this script, which is why picking a specific form in the Meta
// Forms dropdown/tabs shows zero leads for anyone imported before this
// feature existed.
//
// For each such lead, this calls Meta's Graph API directly by leadgen_id
// (GET /{leadgen_id}?fields=form_id,field_data) using the connected Page's
// token, then fills in the missing fields, reassigns Source to the specific
// ad's name (matching how new imports work), and auto-promotes every answer
// into the same CustomField columns new imports get.
//
// Pass --dry-run to only print what would happen, without writing anything.
require("dotenv").config();
const axios = require("axios");
const mongoose = require("mongoose");
const Lead = require("./src/models/Lead");
const LeadSource = require("./src/models/LeadSource");
const MetaIntegration = require("./src/models/MetaIntegration");
const { flattenFieldData, autoPromoteAnswers } = require("./src/services/metaLeadService");

const DRY_RUN = process.argv.includes("--dry-run");
const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

async function fetchLeadFromMeta(leadgenId, integrations) {
  let lastError;
  for (const integration of integrations) {
    try {
      const res = await axios.get(`${GRAPH_API_BASE}/${leadgenId}`, {
        params: { access_token: integration.page_access_token, fields: "form_id,field_data" },
      });
      return { data: res.data, integration };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(DRY_RUN ? "Running in --dry-run mode (no writes).\n" : "Running for real — writes will be committed.\n");

  const orphaned = await Lead.find({
    meta_leadgen_id: { $exists: true, $ne: null, $ne: "" },
    $or: [{ meta_form_id: { $exists: false } }, { meta_form_id: null }, { meta_form_id: "" }],
  });
  console.log(`Found ${orphaned.length} lead(s) missing meta_form_id.\n`);

  const integrationsByTenant = new Map();
  const getIntegrationsForTenant = async (tenantId) => {
    const key = String(tenantId);
    if (!integrationsByTenant.has(key)) {
      integrationsByTenant.set(key, await MetaIntegration.find({ tenant_id: tenantId }));
    }
    return integrationsByTenant.get(key);
  };

  let updated = 0;
  let failed = 0;

  for (const lead of orphaned) {
    const integrations = await getIntegrationsForTenant(lead.tenant_id);
    if (integrations.length === 0) {
      console.log(`SKIP ${lead._id} (${lead.name}) — tenant has no connected Meta Page anymore`);
      failed++;
      continue;
    }

    let result;
    try {
      result = await fetchLeadFromMeta(lead.meta_leadgen_id, integrations);
    } catch (err) {
      const fbMessage = err.response?.data?.error?.message;
      console.log(`FAIL ${lead._id} (${lead.name}) — ${fbMessage || err.message}`);
      failed++;
      continue;
    }

    const { form_id: formId, field_data: fieldData } = result.data;
    const form = result.integration.forms.find((f) => f.form_id === formId);
    const formName = form?.name || "Meta Ads";
    const questionLabels = Object.fromEntries((form?.questions || []).map((q) => [q.key, q.label]));
    const fieldDataMap = flattenFieldData(fieldData);

    console.log(
      `${DRY_RUN ? "WOULD UPDATE" : "UPDATE"} ${lead._id} (${lead.name}) -> form "${formName}" (${formId}), ${Object.keys(fieldDataMap).length} answer(s)`
    );

    if (!DRY_RUN) {
      let sourceDoc = await LeadSource.findOne({ name: formName, tenant_id: lead.tenant_id });
      if (!sourceDoc) {
        sourceDoc = await LeadSource.create({ name: formName, tenant_id: lead.tenant_id });
      }

      lead.meta_form_id = formId;
      lead.meta_form_name = formName;
      lead.meta_field_data = fieldDataMap;
      lead.source = sourceDoc._id;
      await lead.save();

      await autoPromoteAnswers(lead._id, fieldDataMap, questionLabels);
    }
    updated++;
  }

  console.log(`\nDone. ${updated} updated, ${failed} failed/skipped.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
