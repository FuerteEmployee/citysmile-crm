const express = require("express");
const path = require("path");
const router = express.Router();
const { getMedia, createFolder, deleteMedia, upload } = require("../controllers/media_controller");
const { protect } = require("../middleware/auth");

router.use(protect);

// uploads/media/panel holds the Super Admin panel's own logo and favicon
// (Super Admin → Settings). Only a super admin may list, upload to, create
// folders in or delete from it — company users share this media library.
const PROTECTED_FOLDERS = ["panel"];
const topFolder = (p) =>
  path.normalize(String(p || "")).replace(/^[\\/.]+/, "").split(/[\\/]/)[0].toLowerCase();
const guardPanelFolder = (req, res, next) => {
  if (req.user?.is_superadmin) return next();
  const target = req.query.path ?? req.body?.path ?? "";
  const folder = topFolder(target);
  // Deleting/creating the folder itself sits at the root, named in "name".
  const atRootName = !folder ? String(req.body?.name || "").trim().toLowerCase() : "";
  if (PROTECTED_FOLDERS.includes(folder) || PROTECTED_FOLDERS.includes(atRootName)) {
    return res.status(403).json({ message: "This folder can only be changed by the Super Admin" });
  }
  next();
};
router.use(guardPanelFolder);

router.get("/", getMedia);
router.post("/folder", createFolder);
router.delete("/", deleteMedia);
router.post("/upload", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      // 400 = rejected by Allowed file types or the Misc size/count limits; anything else is a real failure.
      if (err.status === 400) return res.status(400).json({ message: err.message });
      console.error("Multer Upload Error:", err);
      return res.status(500).json({ message: "Upload failed: " + err.message });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }
    res.status(201).json({ message: "File uploaded", file: req.file });
  });
});

module.exports = router;
