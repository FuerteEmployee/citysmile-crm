const axios = require("axios");
const Setting = require("../models/Setting");
const Tenant = require("../models/Tenant");

// Merges global defaults (tenant_id: null) with tenant-specific overrides
async function loadTenantSettings(names, tenantId) {
  const docs = await Setting.find({
    name: { $in: names },
    $or: [{ tenant_id: tenantId || null }, { tenant_id: null }],
  });

  const config = {};
  docs
    .filter((d) => d.tenant_id == null)
    .forEach((d) => { config[d.name] = d.value; });
  docs
    .filter((d) => tenantId && String(d.tenant_id) === String(tenantId))
    .forEach((d) => { config[d.name] = d.value; });

  return config;
}

class SmsService {
  async getActiveGateway(tenantId) {
    const config = await loadTenantSettings(
      [
        "smsClickatellKey",
        "smsClickatellActive",
        "smsMsg91Sender",
        "smsMsg91TypeWorld",
        "smsMsg91Auth",
        "smsMsg91Active",
        "smsTwilioSid",
        "smsTwilioToken",
        "smsTwilioPhone",
        "smsTwilioAlpha",
        "smsTwilioActive",
      ],
      tenantId
    );

    const isTrue = (val) => val === true || val === "true" || val === 1 || val === "1";

    if (isTrue(config.smsTwilioActive)) {
      return { provider: "twilio", config };
    }
    if (isTrue(config.smsClickatellActive)) {
      return { provider: "clickatell", config };
    }
    if (isTrue(config.smsMsg91Active)) {
      return { provider: "msg91", config };
    }

    return null;
  }

  async sendSms({ to, message, tenantId }) {
    if (!to || !to.trim()) {
      throw new Error("Recipient phone number is required");
    }
    if (!message || !message.trim()) {
      throw new Error("Message text is required");
    }

    const active = await this.getActiveGateway(tenantId);
    if (!active) {
      throw new Error("No active SMS gateway configured. Please go to Settings > SMS and activate a gateway.");
    }

    const { provider, config } = active;

    if (provider === "twilio") {
      const { smsTwilioSid, smsTwilioToken, smsTwilioPhone, smsTwilioAlpha } = config;
      if (!smsTwilioSid || !smsTwilioToken || (!smsTwilioPhone && !smsTwilioAlpha)) {
        throw new Error("Twilio credentials incomplete. SID, Token, and Phone Number or Alphanumeric ID are required.");
      }

      const from = smsTwilioAlpha?.trim() || smsTwilioPhone?.trim();
      const auth = Buffer.from(`${smsTwilioSid}:${smsTwilioToken}`).toString("base64");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(smsTwilioSid)}/Messages.json`;

      const params = new URLSearchParams();
      params.append("To", to.trim());
      params.append("From", from);
      params.append("Body", message.trim());

      const res = await axios.post(url, params.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      return { success: true, provider: "twilio", data: res.data };
    }

    if (provider === "clickatell") {
      const { smsClickatellKey } = config;
      if (!smsClickatellKey) {
        throw new Error("Clickatell API key is required.");
      }

      const res = await axios.post(
        "https://platform.clickatell.com/messages",
        {
          messages: [{ channel: "sms", to: to.trim(), content: message.trim() }],
        },
        {
          headers: {
            Authorization: smsClickatellKey,
            "Content-Type": "application/json",
          },
        }
      );
      return { success: true, provider: "clickatell", data: res.data };
    }

    if (provider === "msg91") {
      const { smsMsg91Auth, smsMsg91Sender } = config;
      if (!smsMsg91Auth) {
        throw new Error("MSG91 Auth Key is required.");
      }

      const res = await axios.post(
        "https://control.msg91.com/api/v5/flow/",
        {
          sender: smsMsg91Sender || "CRMNOTIFY",
          recipients: [{ mobiles: to.trim(), message: message.trim() }],
        },
        {
          headers: {
            authkey: smsMsg91Auth,
            "Content-Type": "application/json",
          },
        }
      );
      return { success: true, provider: "msg91", data: res.data };
    }

    throw new Error(`Unsupported SMS provider: ${provider}`);
  }

  async sendTestSms(to, tenantId) {
    let companyName = "CRM";
    if (tenantId) {
      const tenant = await Tenant.findById(tenantId).select("company_name").lean();
      if (tenant?.company_name) companyName = tenant.company_name;
    }

    const message = `[${companyName}] This is a test SMS from your CRM system to confirm that your SMS gateway is configured correctly.`;
    return this.sendSms({ to, message, tenantId });
  }
}

module.exports = new SmsService();
