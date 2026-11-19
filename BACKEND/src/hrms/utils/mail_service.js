// Email service (nodemailer). Falls back to a dev-mode console log when SMTP
// is not configured, mirroring the existing whatsapp_service stub behaviour.
const nodemailer = require("nodemailer");

let transporter = null;

const isConfigured = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const getTransporter = () => {
  if (transporter) return transporter;
  if (!isConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE) === "true", // true for 465
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
};

/**
 * @param {object} p
 * @param {string|string[]} p.to
 * @param {string} p.subject
 * @param {string} [p.html]
 * @param {string} [p.text]
 * @returns {Promise<boolean>}
 */
exports.sendEmail = async ({ to, subject, html, text }) => {
  if (!to) return false;
  const t = getTransporter();
  const toStr = Array.isArray(to) ? to.join(", ") : to;

  if (!t) {
    console.log(`[DEV MODE] Email to ${toStr}: "${subject}"`);
    await new Promise((r) => setTimeout(r, 50));
    return true; // pretend success in dev
  }

  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: Array.isArray(to) ? to.join(",") : to,
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, " ").trim() : ""),
      html: html || undefined,
    });
    return true;
  } catch (err) {
    console.error("[Mail Service] Failed to send email:", err.message);
    return false;
  }
};

exports.isConfigured = isConfigured;
