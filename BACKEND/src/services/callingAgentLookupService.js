const Client = require("../models/Client");
const Contact = require("../models/Contact");
const { toE164 } = require("../utils/phoneNormalize");

// A phone match can come from either collection — Client.phoneE164 (the
// customer's own number) or Contact.phoneE164 (a contact person under that
// customer). Either way we resolve up to the parent Client, since that's
// what "customer" means in this codebase (see Client.js / Contact.js).
// Contact isn't tenant-scoped itself, so tenant filtering happens after
// resolving to the parent Client.
async function findCustomersByPhone(rawNumber, tenantId) {
  const e164 = toE164(rawNumber);
  if (!e164) {
    return { e164: null, matchStatus: "not_found", candidateClientIds: [] };
  }

  const [directClients, contacts] = await Promise.all([
    Client.find({ tenant_id: tenantId, phoneE164: e164 }).select("_id"),
    Contact.find({ phoneE164: e164 }).populate({
      path: "userid",
      select: "tenant_id",
    }),
  ]);

  const candidateIds = new Set(directClients.map((c) => c._id.toString()));
  for (const contact of contacts) {
    if (contact.userid && String(contact.userid.tenant_id) === String(tenantId)) {
      candidateIds.add(contact.userid._id.toString());
    }
  }

  const candidateClientIds = Array.from(candidateIds);
  let matchStatus;
  if (candidateClientIds.length === 0) matchStatus = "not_found";
  else if (candidateClientIds.length === 1) matchStatus = "matched";
  else matchStatus = "ambiguous";

  return { e164, matchStatus, candidateClientIds };
}

module.exports = { findCustomersByPhone };
