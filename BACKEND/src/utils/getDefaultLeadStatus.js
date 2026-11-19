const LeadStatus = require("../models/LeadStatus");

// The status new leads land on when created by an automated source (Meta Ads,
// website forms, etc). Prefers whichever status is explicitly flagged
// isdefault; falls back to the lowest statusorder; creates "New" if the
// tenant has no statuses at all yet.
const getDefaultLeadStatus = async (tenantId) => {
  let statusDoc = await LeadStatus.findOne({ tenant_id: tenantId, isdefault: 1 });
  if (!statusDoc) {
    statusDoc = await LeadStatus.findOne({ tenant_id: tenantId }).sort({ statusorder: 1 });
  }
  if (!statusDoc) {
    statusDoc = await LeadStatus.create({ name: "New", tenant_id: tenantId, color: "#2563eb" });
  }
  return statusDoc;
};

module.exports = { getDefaultLeadStatus };
