/**
 * notification_service — one entry point to notify users across every channel
 * (in-app persistence, realtime socket, FCM push, email, WhatsApp) and to
 * resolve recipients by ROLE at a STORE (the MODULE 3 alert-targeting need).
 *
 * Channels auto-enable when their transport is available:
 *   - in-app + socket: always on
 *   - push:   when the recipient has an fcmToken
 *   - email:  when SMTP is configured (else dev-log)
 *   - whatsapp: opt-in (channels.whatsapp === true)
 */
const Role = require("../models/role_model");
const User = require("../models/user_model");
const Notification = require("../models/notification_model");
const fcmService = require("./fcm_service");
const mailService = require("./mail_service");
const whatsappService = require("./whatsapp_service");
const realtime = require("./realtime");

// FCM data payloads must be string values only.
const stringifyData = (data) => {
  const out = {};
  Object.entries(data || {}).forEach(([k, v]) => {
    out[k] = v == null ? "" : String(v);
  });
  return out;
};

// Resolve recipient user docs from explicit ids, or by role(s) at a store.
const resolveRecipients = async ({ storeId, roleKeys, userIds }) => {
  if (Array.isArray(userIds) && userIds.length) {
    return User.find({ _id: { $in: userIds }, isActive: true });
  }
  const keys = (roleKeys || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  if (!keys.length) return [];

  const roles = await Role.find({ role: { $in: keys } }).select("_id");
  const roleIds = roles.map((r) => r._id);
  if (!roleIds.length) return [];

  const query = { role: { $in: roleIds }, isActive: true };
  if (storeId) query.storeId = storeId;
  return User.find(query);
};

// Fan a single message out to a set of resolved user docs.
const deliver = async (recipients, msg) => {
  const { title, body, data, severity, type, refType, refId, storeId } = msg;
  const ch = msg.channels || {};
  const pushOn = ch.push !== false;
  const emailOn = ch.email !== false;
  const inappOn = ch.inapp !== false;
  const socketOn = ch.socket !== false;
  const whatsappOn = ch.whatsapp === true; // opt-in

  const results = { recipients: recipients.length, inapp: 0, socket: 0, push: 0, email: 0, whatsapp: 0 };

  for (const user of recipients) {
    if (inappOn) {
      try {
        await Notification.create({
          userId: user._id, type, title, body,
          data: data || {}, severity, channel: "inapp", refType, refId, storeId,
        });
        results.inapp++;
      } catch (e) {
        console.error("[Notification] in-app persist failed:", e.message);
      }
    }

    if (socketOn) {
      realtime.emitToUser(user._id, "notification", {
        type, title, body, data: data || {}, severity, createdAt: new Date(),
      });
      results.socket++;
    }

    if (pushOn && user.fcmToken) {
      const ok = await fcmService.sendPushNotification({
        token: user.fcmToken, title, body, data: stringifyData(data),
      });
      if (ok) results.push++;
    }

    if (emailOn && user.email) {
      const ok = await mailService.sendEmail({
        to: user.email,
        subject: title,
        html: `<p>${body}</p>`,
      });
      if (ok) results.email++;
    }

    if (whatsappOn && user.mobile) {
      const ok = await whatsappService.sendWhatsAppMessage(user.mobile, `${title}\n${body}`);
      if (ok) results.whatsapp++;
    }
  }

  // Store-room broadcast so any dashboard listening on store-{id} updates live.
  if (socketOn && storeId) {
    realtime.emitToStore(storeId, "stock:alert", {
      type, title, body, severity, data: data || {}, createdAt: new Date(),
    });
  }

  return results;
};

/** Notify every user holding any of roleKeys at a store (or globally if no storeId). */
const notifyRolesAtStore = async ({ storeId, roleKeys, ...msg }) => {
  const recipients = await resolveRecipients({ storeId, roleKeys });
  if (!recipients.length) {
    console.warn(
      `[Notification] No recipients for roles [${(roleKeys || []).join(", ")}]` +
        (storeId ? ` at store ${storeId}` : "")
    );
    return { recipients: 0 };
  }
  return deliver(recipients, { ...msg, storeId, severity: msg.severity || "info", type: msg.type || "general" });
};

/** Notify a specific set of users by id. */
const notifyUsers = async ({ userIds, ...msg }) => {
  const recipients = await resolveRecipients({ userIds });
  if (!recipients.length) return { recipients: 0 };
  return deliver(recipients, { ...msg, severity: msg.severity || "info", type: msg.type || "general" });
};

module.exports = { notifyRolesAtStore, notifyUsers, resolveRecipients };
