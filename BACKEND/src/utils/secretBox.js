const crypto = require("crypto");

// AES-256-GCM for third-party credentials stored in the DB (e.g. Meta Ads
// access tokens). The key comes only from INTEGRATION_ENCRYPTION_KEY — any
// string works; it is stretched to 32 bytes with SHA-256. Changing the key
// makes previously stored secrets unreadable (accounts must be reconnected).
const PREFIX = "gcm1";

const getKey = () => {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw || raw.length < 16) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
};

const isConfigured = () => !!getKey();

const encryptSecret = (plain) => {
  const key = getKey();
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured on the server");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
};

const decryptSecret = (stored) => {
  const key = getKey();
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured on the server");
  const [prefix, ivB64, tagB64, dataB64] = String(stored || "").split(":");
  if (prefix !== PREFIX || !ivB64 || !tagB64 || !dataB64) throw new Error("Stored secret is not in the expected format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
};

const maskSecret = (plain) => {
  const s = String(plain || "");
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
};

module.exports = { encryptSecret, decryptSecret, maskSecret, isConfigured };
