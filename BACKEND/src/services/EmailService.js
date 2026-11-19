
const nodemailer = require("nodemailer");
const Setting = require("../models/Setting");
const Tenant = require("../models/Tenant");

// `Setting` stores one global default row (tenant_id: null) plus one
// override row per tenant per setting name. Merges them so a tenant's own
// value always wins over the global default for the same name — without
// this, a query across all tenants' rows lands on whichever one Mongo
// happens to return last, which is effectively random.
async function loadTenantSettings(names, tenantId) {
  const docs = await Setting.find({
    name: { $in: names },
    $or: [{ tenant_id: tenantId || null }, { tenant_id: null }],
  });

  const config = {};
  // Apply global defaults first, then tenant-specific overrides, so the
  // tenant's own row always wins when both exist for the same name.
  docs
    .filter((d) => d.tenant_id == null)
    .forEach((d) => { config[d.name] = d.value; });
  docs
    .filter((d) => tenantId && String(d.tenant_id) === String(tenantId))
    .forEach((d) => { config[d.name] = d.value; });

  return config;
}

class EmailService {
  async getTransporter(tenantId) {
    const config = await loadTenantSettings(
      ["smtpHost", "smtpPort", "smtpUser", "smtpPass", "smtpEncryption", "smtpEmail"],
      tenantId,
    );

    return nodemailer.createTransport({
      host: config.smtpHost,
      port: parseInt(config.smtpPort) || 587,
      secure: config.smtpEncryption === "ssl", // true for 465, false for other ports
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });
  }

  async sendOtpCode(to, code, tenantId) {
    const config = await loadTenantSettings(
      ["companyName", "smtpEmail", "smtpHost"],
      tenantId,
    );

    // Tenant.company_name is ALWAYS the canonical display name — it is what
    // the admin sets in Settings > General and what setting_controller.js
    // already overrides the Setting collection value with when serving the
    // frontend. We must do the same here: always prefer Tenant.company_name
    // over whatever "companyName" row may exist in the Setting collection
    // (that row can hold a stale/global value like "Fuerte CRM" that does
    // not belong to this tenant).
    if (tenantId) {
      const tenant = await Tenant.findById(tenantId).select("company_name").lean();
      if (tenant?.company_name) config.companyName = tenant.company_name;
    }

    // No SMTP configured yet for this tenant (Settings > Email) — same dev
    // fallback the HRMS mail service already uses elsewhere in this app.
    // The code is still printed to the server console by the caller, so
    // local testing works before SMTP is set up; it just doesn't block login.
    if (!config.smtpHost) {
      console.warn(
        `[EmailService] No SMTP host configured for tenant ${tenantId || "(default)"} — OTP email not sent, code is only in the server console. Configure Settings > Email to send it for real.`,
      );
      return;
    }

    const transporter = await this.getTransporter(tenantId);

    return transporter.sendMail({
      from: `"${config.companyName || 'CRM Pro'}" <${config.smtpEmail}>`,
      to: to,
      subject: "Your login verification code",
      text: `Your verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px;">${code}</h2><p>This code expires in 10 minutes. If you didn't try to log in, you can ignore this email.</p>`,
    });
  }

  /**
   * Sends one email through the tenant's own SMTP (Settings > Email).
   * Throws "SMTP not configured..." when the tenant has not set it up.
   */
  async sendMail({ tenantId, to, cc, subject, text, html, attachments }) {
    const config = await loadTenantSettings(["companyName", "smtpEmail", "smtpHost"], tenantId);
    if (tenantId) {
      const tenant = await Tenant.findById(tenantId).select("company_name").lean();
      if (tenant?.company_name) config.companyName = tenant.company_name;
    }
    if (!config.smtpHost) {
      throw new Error("SMTP not configured. Please go to Settings > Email and fill in your SMTP details first.");
    }
    const transporter = await this.getTransporter(tenantId);
    const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return transporter.sendMail({
      from: `"${(config.companyName || "CRM Pro").replace(/"/g, "")}" <${config.smtpEmail}>`,
      to,
      cc: cc && cc.length ? cc : undefined,
      subject,
      text,
      html: html || `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;">${escape(text)}</div>`,
      attachments,
    });
  }

  async sendTestEmail(to, tenantId) {
    try {
      const config = await loadTenantSettings(["companyName", "smtpEmail", "smtpHost"], tenantId);

      // Same Tenant.company_name priority override as sendOtpCode — always use
      // the tenant's own company_name over any Setting collection value.
      if (tenantId) {
        const tenant = await Tenant.findById(tenantId).select("company_name").lean();
        if (tenant?.company_name) config.companyName = tenant.company_name;
      }

      // No SMTP configured — return a clear error instead of crashing with 500.
      if (!config.smtpHost) {
        console.warn(`[EmailService] sendTestEmail: No SMTP host configured for tenant ${tenantId || "(default)"} — go to Settings > Email to set it up.`);
        throw new Error("SMTP not configured. Please go to Settings > Email and fill in your SMTP details first.");
      }

      const transporter = await this.getTransporter(tenantId);
      const displayName = config.companyName || "CRM Pro";
      console.log(`[EmailService] Sending test email to ${to} | From: "${displayName}" <${config.smtpEmail}> | tenantId: ${tenantId}`);

      const result = await transporter.sendMail({
        from: `"${displayName}" <${config.smtpEmail}>`,
        to: to,
        subject: `Test Email from ${displayName}`,
        text: "If you are receiving this email, it means your SMTP settings are working correctly.",
        html: "<b>If you are receiving this email, it means your SMTP settings are working correctly.</b>",
      });
      console.log(`[EmailService] Test email sent successfully:`, result.messageId);
      return result;
    } catch (err) {
      console.error(`[EmailService] sendTestEmail FAILED:`, err.message, err.code || "", err.response || "");
      throw err;
    }
  }
}

module.exports = new EmailService();
