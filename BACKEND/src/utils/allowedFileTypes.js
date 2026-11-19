const path = require("path");
const Setting = require("../models/Setting");

// Setup > Settings > General > "Allowed file types" — enforced for attachment
// uploads (customer/lead/task/project files, ticket attachments, Media).
// Special-purpose uploads (Excel imports, WhatsApp images, selfies, meeting
// recordings, module zips, logos) keep their own fixed type rules.

const DEFAULT_ALLOWED = ".png,.jpg,.jpeg,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.txt";
const CACHE_MS = 60 * 1000;
// Name the in-app recorder gives voice notes (components/tasks/TaskVoiceNotes.tsx).
const VOICE_NOTE_NAME = /^voice-note-\d{8}_\d{4}\.(webm|m4a|ogg|wav)$/i;
const cache = new Map(); // tenant id ("global" for none) -> { list, at }

/** ".PDF, docx  .jpg" -> ["pdf", "docx", "jpg"] */
const parseAllowedFileTypes = (raw) =>
  [...new Set(String(raw || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean))];

const getAllowedExtensions = async (tenantId) => {
  const key = tenantId ? String(tenantId) : "global";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;

  const [tenantRow, globalRow] = await Promise.all([
    tenantId ? Setting.findOne({ name: "allowedFileTypes", tenant_id: tenantId }).lean() : null,
    Setting.findOne({ name: "allowedFileTypes", tenant_id: null }).lean(),
  ]);
  // An empty field means "use the default list", never "allow everything".
  const raw = [tenantRow?.value, globalRow?.value].find((v) => String(v || "").trim()) || DEFAULT_ALLOWED;
  const list = parseAllowedFileTypes(raw);
  cache.set(key, { list, at: Date.now() });
  return list;
};

/** Call after Setup > Settings saves a new list so it applies immediately. */
const invalidateAllowedFileTypes = (tenantId) => {
  if (tenantId) cache.delete(String(tenantId));
  else cache.clear();
};

/** multer fileFilter: rejects files whose extension is not in the company's list (HTTP 400). */
const allowedFileTypesFilter = (req, file, cb) => {
  getAllowedExtensions(req.user?.tenant_id)
    .then((list) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/^\./, "");
      if (ext && list.includes(ext)) return cb(null, true);
      // Voice notes recorded inside the CRM (tasks) always go through, so a
      // list without audio types doesn't break the built-in recorder.
      if (VOICE_NOTE_NAME.test(file.originalname || "") && /^audio\//.test(file.mimetype || "")) return cb(null, true);
      const err = new Error(
        `File type "${ext ? "." + ext : file.originalname}" is not allowed. Allowed file types: ${list.map((e) => "." + e).join(", ")}`
      );
      err.status = 400;
      cb(err);
    })
    .catch((e) => {
      // Settings lookup failed (DB hiccup) — don't block every upload in the CRM.
      console.error("[allowedFileTypes] lookup failed, allowing upload:", e.message);
      cb(null, true);
    });
};

module.exports = { DEFAULT_ALLOWED, parseAllowedFileTypes, getAllowedExtensions, invalidateAllowedFileTypes, allowedFileTypesFilter };
