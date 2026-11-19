const File = require("../models/File");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { logActivity } = require("../services/ActivityLogService");
const { allowedFileTypesFilter } = require("../utils/allowedFileTypes");
const { limitedUpload } = require("../utils/uploadLimits");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

// Attachments (customer/lead/task/project files, ticket attachments) follow
// Setup > Settings > General > "Allowed file types", and Misc > max file
// size / files per upload.
const upload = limitedUpload({ storage: storage, fileFilter: allowedFileTypesFilter });

const getFiles = async (req, res) => {
  const { rel_id, rel_type } = req.query;
  try {
    const query = {};
    if (rel_id) query.rel_id = rel_id;
    if (rel_type) query.rel_type = rel_type;
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const files = await File.find(query).populate("addedfrom", "firstname lastname");
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const uploadFiles = async (req, res) => {
  try {
    const { rel_id, rel_type } = req.body;
    const filesData = req.files.map((file) => ({
      rel_id: rel_id || req.params.id, // Support both body and param
      rel_type: rel_type || "customer",
      file_name: file.originalname,
      filetype: file.mimetype,
      size: file.size,
      attachment_key: file.filename,
      addedfrom: req.user._id,
      tenant_id: req.user?.tenant_id,
    }));

    const savedFiles = await File.insertMany(filesData);
    if (rel_type === "lead" && rel_id) {
      logActivity(req, `Uploaded ${savedFiles.length} file(s)`, { rel_id, rel_type: "lead" });
    }
    if (rel_type === "task" && rel_id) {
      logActivity(req, `Uploaded ${savedFiles.length} file(s) to task`, { rel_id, rel_type: "task" });
    }
    res.status(201).json(savedFiles);
  } catch (error) {
    // multer already wrote the files; without a DB record nothing can ever
    // reach or delete them, so remove them instead of leaving orphans.
    (req.files || []).forEach((f) => fs.promises.unlink(f.path).catch(() => {}));
    res.status(500).json({ message: error.message });
  }
};

const deleteFile = async (req, res) => {
  try {
    // Same company scope as getFiles: a file of another company is "not found".
    if (!/^[0-9a-f]{24}$/i.test(String(req.params.fileId))) {
      return res.status(404).json({ message: "File not found" });
    }
    const scope = !req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const file = await File.findOne({ _id: req.params.fileId, ...scope });
    if (!file) {
      return res.status(404).json({ message: "File not found" });
    }

    const filePath = path.join(__dirname, "../uploads", path.basename(String(file.attachment_key || "")));
    if (file.attachment_key && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await file.deleteOne();
    res.json({ message: "File removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getClientFiles = async (req, res) => {
    try {
        const files = await File.find({ rel_id: req.params.id, rel_type: 'customer' })
            .populate("addedfrom", "firstname lastname");
        res.json(files);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
  upload,
  getFiles,
  uploadFiles,
  deleteFile,
  getClientFiles
};
