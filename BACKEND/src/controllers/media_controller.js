const fs = require("fs");
const path = require("path");
const multer = require("multer");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads", "media");

// Ensure root exists
if (!fs.existsSync(UPLOADS_ROOT)) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

const getMedia = async (req, res) => {
  try {
    const relativePath = req.query.path || "";
    const fullPath = path.join(UPLOADS_ROOT, relativePath);

    // Prevent directory traversal
    if (!fullPath.startsWith(UPLOADS_ROOT)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "Path not found" });
    }

    const items = fs.readdirSync(fullPath).map((name) => {
      const stats = fs.statSync(path.join(fullPath, name));
      return {
        name,
        isFolder: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime,
        extension: path.extname(name).toLowerCase(),
      };
    });

    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createFolder = async (req, res) => {
  try {
    const { path: relativePath, name } = req.body;
    console.log("Creating folder:", { relativePath, name });
    
    const safeRelativePath = path.join(".", relativePath || "").replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(UPLOADS_ROOT, safeRelativePath, name);

    if (!fullPath.startsWith(UPLOADS_ROOT)) {
      return res.status(403).json({ message: "Access denied: Path out of bounds" });
    }

    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ message: "Folder already exists" });
    }

    fs.mkdirSync(fullPath, { recursive: true });
    console.log("Folder created successfully at:", fullPath);
    res.status(201).json({ message: "Folder created" });
  } catch (error) {
    console.error("Create Folder Error:", error);
    res.status(500).json({ message: "Creation Failed: " + error.message });
  }
};

const deleteMedia = async (req, res) => {
  try {
    const { path: relativePath, name } = req.body;
    const fullPath = path.join(UPLOADS_ROOT, relativePath, name);

    if (!fullPath.startsWith(UPLOADS_ROOT)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "Item not found" });
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    res.json({ message: "Item deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Multer config for upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const relativePath = req.query.path || "";
      // Ensure relativePath is not absolute and doesn't escape UPLOADS_ROOT
      const safePath = path.join(".", relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
      const fullPath = path.join(UPLOADS_ROOT, safePath);
      
      console.log("Upload destination:", fullPath);
      
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
      cb(null, fullPath);
    } catch (err) {
      console.error("Multer Destination Error:", err);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, Date.now() + "-" + cleanName);
  },
});

const upload = require("../utils/uploadLimits").limitedUpload({ storage, fileFilter: require("../utils/allowedFileTypes").allowedFileTypesFilter });

module.exports = { getMedia, createFolder, deleteMedia, upload };
