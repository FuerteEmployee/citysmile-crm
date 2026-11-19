const multer = require("multer");
const Setting = require("../models/Setting");

// Setup > Settings > Misc > "Max file size upload in Media (MB)" and
// "Maximum files upload on post" — enforced on every attachment/media upload.
const DEFAULT_MAX_MB = 50;
const DEFAULT_MAX_FILES = 10;
const CACHE_MS = 60 * 1000;
const cache = new Map(); // tenant id ("global" for none) -> { limits, at }

const getUploadLimits = async (tenantId) => {
  const key = tenantId ? String(tenantId) : "global";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.limits;
  const names = ["miscMaxFileSize", "miscMaxFilesPost"];
  const rows = await Setting.find({ name: { $in: names }, $or: [{ tenant_id: tenantId || null }, { tenant_id: null }] }).lean();
  const value = (name) => {
    const own = tenantId ? rows.find((r) => r.name === name && String(r.tenant_id) === String(tenantId)) : null;
    return (own ?? rows.find((r) => r.name === name && r.tenant_id == null))?.value;
  };
  const num = (v, def) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const maxMb = num(value("miscMaxFileSize"), DEFAULT_MAX_MB);
  const maxFiles = Math.floor(num(value("miscMaxFilesPost"), DEFAULT_MAX_FILES));
  const limits = { maxMb, maxBytes: Math.round(maxMb * 1024 * 1024), maxFiles };
  cache.set(key, { limits, at: Date.now() });
  return limits;
};

/** Call after Setup > Settings saves new limits so they apply immediately. */
const invalidateUploadLimits = (tenantId) => {
  if (tenantId) cache.delete(String(tenantId));
  else cache.clear();
};

/**
 * Same shape as a multer instance (`.single(field)` / `.array(field)`), but the
 * size and count limits come from the uploader's company settings. A file that
 * is too big or too many files give a 400 with a readable message.
 */
const limitedUpload = (multerOptions) => {
  const wrap = (pick) => (req, res, next) => {
    getUploadLimits(req.user?.tenant_id)
      .catch(() => ({ maxMb: DEFAULT_MAX_MB, maxBytes: DEFAULT_MAX_MB * 1024 * 1024, maxFiles: DEFAULT_MAX_FILES }))
      .then(({ maxMb, maxBytes, maxFiles }) => {
        const instance = multer({ ...multerOptions, limits: { ...(multerOptions.limits || {}), fileSize: maxBytes, files: maxFiles } });
        pick(instance)(req, res, (err) => {
          if (err instanceof multer.MulterError) {
            err.status = 400;
            if (err.code === "LIMIT_FILE_SIZE") {
              err.message = `File is too large — the maximum upload size is ${maxMb} MB (Setup > Settings > Misc).`;
            } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
              err.message = `Too many files — you can upload at most ${maxFiles} file(s) at once (Setup > Settings > Misc).`;
            }
          }
          next(err);
        });
      });
  };
  return {
    single: (field) => wrap((m) => m.single(field)),
    array: (field, maxCount) => wrap((m) => m.array(field, maxCount)),
  };
};

module.exports = { getUploadLimits, invalidateUploadLimits, limitedUpload };
