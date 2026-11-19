const fs = require("fs");
const path = require("path");
const multer = require("multer");
const AdmZip = require("adm-zip");
const Module = require("../models/Module");
const Setting = require("../models/Setting");

// Built-in feature modules — their on/off state is a Setting row named
// `module_<key>` (unchanged from the old toggle-panel behavior). Listed here
// alongside uploaded custom modules so the Modules page shows one unified,
// dynamic table instead of two disconnected concepts.
const CORE_MODULES = [
  { key: "subscriptions", name: "Subscriptions", description: "Recurring billing plans and subscription management." },
  { key: "expenses", name: "Expenses", description: "Track business expenses and link them to clients or projects." },
  { key: "contracts", name: "Contracts", description: "Draft, sign, and manage client contracts." },
  { key: "projects", name: "Projects", description: "Organize client work into projects with tasks and milestones." },
  { key: "tasks", name: "Tasks", description: "Assign and track tasks across staff and projects." },
  { key: "timeTracking", name: "Time Tracking", description: "Log billable and non-billable hours." },
  { key: "support", name: "Support", description: "Customer support ticketing system." },
  { key: "leads", name: "Leads", description: "Capture and manage sales leads through your pipeline." },
  { key: "estimateRequest", name: "Estimate Request", description: "Public estimate request forms and submissions." },
  { key: "knowledgeBase", name: "Knowledge Base", description: "Internal and customer-facing help articles." },
  { key: "media", name: "Media", description: "Central file and media library." },
  { key: "goals", name: "Goals", description: "Set and track sales/performance goals." },
];

const uploadDir = path.join(__dirname, "../uploads/modules");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const isZip = file.mimetype === "application/zip" || file.originalname.toLowerCase().endsWith(".zip");
    if (!isZip) return cb(new Error("Only .zip files are accepted"));
    cb(null, true);
  },
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

const getModules = async (req, res) => {
  try {
    const settingNames = CORE_MODULES.map((m) => `module_${m.key}`);
    const settings = await Setting.find({ name: { $in: settingNames } });
    const settingMap = new Map(settings.map((s) => [s.name, s.value]));

    const coreModules = CORE_MODULES.map((m) => ({
      _id: `core_${m.key}`,
      slug: m.key,
      name: m.name,
      description: m.description,
      version: "core",
      core: true,
      active: settingMap.get(`module_${m.key}`) !== false && settingMap.get(`module_${m.key}`) !== "false",
      createdAt: null,
    }));

    // Installed modules are a platform-level feature, same as the core
    // modules above — every admin across every tenant sees the same catalog,
    // so a module installed by one admin shows up dynamically for all others.
    const customModules = await Module.find({}).sort({ createdAt: -1 });

    res.json([
      ...coreModules,
      ...customModules.map((m) => ({ ...m.toObject(), core: false })),
    ]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const installModule = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No .zip file uploaded" });

    let manifest = {};
    try {
      const zip = new AdmZip(req.file.path);
      const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith("module.json"));
      if (entry) {
        manifest = JSON.parse(zip.readAsText(entry));
      }
    } catch (zipError) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: "Could not read the uploaded file as a valid .zip archive." });
    }

    const baseName = req.file.originalname.replace(/\.zip$/i, "");
    const name = manifest.name || baseName;
    const slug = (manifest.slug || name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    const existing = await Module.findOne({ slug });
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: `A module named "${name}" is already installed.` });
    }

    const installedModule = await Module.create({
      name,
      slug,
      description: manifest.description || "",
      version: manifest.version || "1.0.0",
      filename: req.file.filename,
      installed_by: req.user?._id,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json(installedModule);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const toggleModule = async (req, res) => {
  try {
    const { slug, core, active } = req.body;
    if (typeof active !== "boolean" || !slug) {
      return res.status(400).json({ message: "slug and active (boolean) are required" });
    }

    if (core) {
      await Setting.findOneAndUpdate(
        { name: `module_${slug}` },
        { name: `module_${slug}`, value: active },
        { upsert: true }
      );
      return res.json({ slug, active, core: true });
    }

    const updated = await Module.findOneAndUpdate({ slug }, { active }, { new: true });
    if (!updated) return res.status(404).json({ message: "Module not found" });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteModule = async (req, res) => {
  try {
    const moduleDoc = await Module.findByIdAndDelete(req.params.id);
    if (!moduleDoc) return res.status(404).json({ message: "Module not found" });

    const filePath = path.join(uploadDir, moduleDoc.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({ message: "Module uninstalled successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { upload, getModules, installModule, toggleModule, deleteModule };
