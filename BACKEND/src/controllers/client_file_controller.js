// Customer files tab (/api/clients/:id/files). Its own upload middleware so the
// type / size rules here don't change the shared /api/files and ticket uploads.
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const File = require("../models/File");
const { findOwnClient } = require("../utils/customerRules");
const { isObjectId, statusForError } = require("../utils/requestSafety");

const UPLOAD_DIR = path.join(__dirname, "../uploads");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
// Documents and images only. Anything a browser could run (html, svg, js, exe…) is refused,
// because /uploads is served publicly from the app's origin.
const ALLOWED_EXT = new Set(["pdf", "png", "jpg", "jpeg", "webp", "gif", "doc", "docx", "xls", "xlsx", "csv", "txt"]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const safeName = path.basename(file.originalname).replace(/[^\w.\- ]+/g, "_");
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`);
  },
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").slice(1).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      const err = new Error(`File type .${ext || "?"} is not allowed. Allowed: ${[...ALLOWED_EXT].join(", ")}`);
      err.status = 400;
      return cb(err);
    }
    const mime = String(file.mimetype || "").toLowerCase();
    if (/html|javascript|svg|application\/(x-msdownload|x-executable|x-sh)/i.test(mime)) {
      const err = new Error(`File MIME type ${mime} is not allowed`);
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
}).array("files");

const removeUploaded = (files = []) => {
  for (const f of files) {
    try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch { /* ignore */ }
  }
};

// The customer must exist in the caller's company BEFORE anything is written to disk.
const requireOwnClient = async (req, res, next) => {
  try {
    const client = await findOwnClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    req.customer = client;
    next();
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const uploadCustomerFiles = (req, res, next) =>
  uploader(req, res, (err) => {
    if (!err) return next();
    removeUploaded(req.files);
    if (err instanceof multer.MulterError) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 10 MB)" : err.message;
      return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ message: msg });
    }
    return res.status(err.status || 400).json({ message: err.message });
  });

const saveCustomerFiles = async (req, res) => {
  try {
    if (!Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ message: "Choose at least one file to upload" });
    }
    const saved = await File.insertMany(req.files.map((file) => ({
      rel_id: req.customer._id,
      rel_type: "customer",
      file_name: path.basename(file.originalname),
      filetype: file.mimetype,
      size: file.size,
      attachment_key: file.filename,
      addedfrom: req.user._id,
      tenant_id: req.user?.tenant_id,
    })));
    res.status(201).json(saved);
  } catch (error) {
    removeUploaded(req.files);
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const getCustomerFiles = async (req, res) => {
  try {
    const files = await File.find({ rel_id: req.customer._id, rel_type: "customer" }).populate("addedfrom", "firstname lastname");
    res.json(files);
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

const deleteCustomerFile = async (req, res) => {
  try {
    if (!isObjectId(String(req.params.fileId))) return res.status(404).json({ message: "File not found" });
    const file = await File.findOne({ _id: req.params.fileId, rel_id: req.customer._id, rel_type: "customer" });
    if (!file) return res.status(404).json({ message: "File not found" });
    if (file.attachment_key) {
      const p = path.join(UPLOAD_DIR, path.basename(file.attachment_key));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await file.deleteOne();
    res.json({ message: "File removed" });
  } catch (error) {
    res.status(statusForError(error)).json({ message: error.message });
  }
};

module.exports = { requireOwnClient, uploadCustomerFiles, saveCustomerFiles, getCustomerFiles, deleteCustomerFile, MAX_FILE_BYTES, ALLOWED_EXT };
