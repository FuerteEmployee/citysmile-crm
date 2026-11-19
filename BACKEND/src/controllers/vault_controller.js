const VaultEntry = require("../models/VaultEntry");
const { encryptSecret, decryptSecret, isConfigured } = require("../utils/secretBox");
const { withoutProtected, isObjectId, statusForError } = require("../utils/requestSafety");
const { tenantScope, findOwnClient, HTML_TAG } = require("../utils/customerRules");
const { checkLength, firstError, isBlank } = require("../hrms/utils/fieldRules");

// Vault passwords are stored encrypted (AES-256-GCM, utils/secretBox) when
// INTEGRATION_ENCRYPTION_KEY is set. Rows saved before that are plain text and
// are returned as-is, so old entries keep working.
const ENCRYPTED_PREFIX = "gcm1:";
const sealPassword = (plain) => (isConfigured() ? encryptSecret(plain) : String(plain));
const openPassword = (stored) => {
  if (typeof stored !== "string" || !stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  try {
    return decryptSecret(stored);
  } catch (err) {
    console.error("[vault] could not decrypt a vault password:", err.message);
    return "";
  }
};
const toPublic = (entry) => {
  const o = entry.toObject ? entry.toObject() : { ...entry };
  o.password = openPassword(o.password);
  return o;
};

const VAULT_FIELDS = ["server", "port", "username", "password", "description", "visibility", "share_in_projects"];

const getVaultEntries = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const entries = await VaultEntry.find({ client: client._id, ...tenantScope(req) });
    res.json(entries.map(toPublic));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const createVaultEntry = async (req, res) => {
  try {
    const client = await findOwnClient(req, req.params.clientId);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const src = withoutProtected(req.body || {});
    const data = {};
    for (const k of VAULT_FIELDS) if (k in src) data[k] = typeof src[k] === "string" ? src[k].trim() : src[k];
    const error = firstError(
      isBlank(data.server) ? "Server address is required" : null,
      isBlank(data.username) ? "Username is required" : null,
      isBlank(data.password) ? "Password is required" : null,
      checkLength("Server address", data.server, 300),
      checkLength("Port", data.port, 10),
      checkLength("Username", data.username, 200),
      checkLength("Password", data.password, 500),
      checkLength("Description", data.description, 2000),
      ["server", "username", "description"].some((k) => typeof data[k] === "string" && HTML_TAG.test(data[k])) ? "Vault fields must not contain HTML tags" : null,
    );
    if (error) return res.status(400).json({ message: error });

    const entry = await VaultEntry.create({
      ...data,
      password: sealPassword(data.password),
      client: client._id,
      created_by: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(toPublic(entry));
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteVaultEntry = async (req, res) => {
  try {
    if (!isObjectId(String(req.params.id))) return res.status(404).json({ message: "Entry not found" });
    // Ownership is checked through the entry's customer (older rows may have no tenant_id).
    const entry = await VaultEntry.findById(req.params.id);
    if (!entry || !(await findOwnClient(req, entry.client))) return res.status(404).json({ message: "Entry not found" });
    await entry.deleteOne();
    res.json({ message: "Vault entry removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

module.exports = { getVaultEntries, createVaultEntry, deleteVaultEntry };
