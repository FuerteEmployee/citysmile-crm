const Lead = require("../models/Lead");
const LeadSource = require("../models/LeadSource");
const { getDefaultLeadStatus } = require("../utils/getDefaultLeadStatus");

const WHATSAPP_SOURCE_NAME = "WhatsApp";
const MAX_STORED_MESSAGE = 1000;

const last10 = (mobile) => String(mobile || "").replace(/\D/g, "").slice(-10);
const clip = (text) => String(text || "").slice(0, MAX_STORED_MESSAGE);

const getWhatsAppSource = async (tenantId) => {
  let source = await LeadSource.findOne({
    tenant_id: tenantId,
    name: { $regex: /^whatsapp$/i },
  });
  if (!source) source = await LeadSource.create({ name: WHATSAPP_SOURCE_NAME, tenant_id: tenantId });
  return source;
};

// Click-to-WhatsApp ads attach a `referral` object to the first message.
const campaignFromReferral = (referral) => {
  if (!referral) return "";
  return String(referral.headline || (referral.source_id ? `Ad ${referral.source_id}` : "") || "").trim().slice(0, 200);
};

// Phone match, preferring the indexed phone_last10 and falling back to the
// suffix regex for older leads saved before phone_last10 existed.
const findLeadByPhone = (tenantId, mobile) =>
  Lead.findOne({
    tenant_id: tenantId,
    $or: [{ phone_last10: mobile }, { phonenumber: { $regex: `${mobile}$` } }],
  }).sort({ createdAt: 1 });

/**
 * Creates the CRM lead for an inbound WhatsApp enquiry, or updates the
 * existing lead with the same number (deduplicated per tenant by the last 10
 * digits of the phone number). Returns { created, lead }.
 */
const upsertLeadFromWhatsApp = async ({ tenantId, from, senderName, text, receivedAt, referral }) => {
  const mobile = last10(from);
  if (mobile.length !== 10) throw new Error(`Unusable WhatsApp sender number "${from}"`);

  const at = receivedAt instanceof Date && !isNaN(receivedAt) ? receivedAt : new Date();
  const campaign = campaignFromReferral(referral);

  const touchExisting = async (lead) => {
    const update = {
      $set: { whatsapp_last_message: clip(text), whatsapp_last_message_at: at, lastcontact: at },
      $inc: { whatsapp_message_count: 1 },
    };
    if (!lead.whatsapp_wa_id) update.$set.whatsapp_wa_id = String(from);
    if (!lead.phone_last10) update.$set.phone_last10 = mobile;
    if (campaign && !lead.campaign) update.$set.campaign = campaign;
    const updated = await Lead.findByIdAndUpdate(lead._id, update, { new: true });
    return { created: false, lead: updated };
  };

  const existing = await findLeadByPhone(tenantId, mobile);
  if (existing) return touchExisting(existing);

  const [source, status] = await Promise.all([getWhatsAppSource(tenantId), getDefaultLeadStatus(tenantId)]);

  try {
    const lead = await Lead.create({
      tenant_id: tenantId,
      name: (senderName || "").trim() || `WhatsApp ${mobile}`,
      phonenumber: mobile,
      phone_last10: mobile,
      source: source._id,
      status: status._id,
      campaign,
      origin: "whatsapp",
      whatsapp_wa_id: String(from),
      whatsapp_first_message: clip(text),
      whatsapp_last_message: clip(text),
      whatsapp_last_message_at: at,
      whatsapp_message_count: 1,
      lastcontact: at,
      dateadded: at,
      description: text ? `WhatsApp enquiry: ${clip(text)}` : "WhatsApp enquiry",
    });
    return { created: true, lead };
  } catch (err) {
    // Another delivery created this number's lead between our lookup and
    // insert (uniq_whatsapp_lead_per_phone) — treat it as an update instead.
    if (err.code === 11000) {
      const raced = await findLeadByPhone(tenantId, mobile);
      if (raced) return touchExisting(raced);
    }
    throw err;
  }
};

module.exports = { upsertLeadFromWhatsApp, getWhatsAppSource, WHATSAPP_SOURCE_NAME };
