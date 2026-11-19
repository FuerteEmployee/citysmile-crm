const Bookmark = require('../models/Bookmark');

// Validates bookmark URLs defensively against Stored XSS (javascript:, data:, vbscript:)
const isValidUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return false;
  }
  // Allow internal CRM SPA paths (e.g. /admin/customers, /staff/dashboard)
  if (trimmed.startsWith('/')) {
    return true;
  }
  // Validate web protocols (http://, https://)
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const getBookmarks = async (req, res) => {
  try {
    let tenant_id = req.user?.tenant_id;
    // SuperAdmin fallback if tenant_id query param passed
    if (!tenant_id && req.user?.is_superadmin && req.query.tenant_id) {
      tenant_id = req.query.tenant_id;
    }
    if (!tenant_id) return res.json([]);

    const filter = { tenant_id };
    
    // Non-admin staff only see public bookmarks OR bookmarks they personally created
    const isAdmin = Boolean(req.user?.admin || req.user?.is_superadmin);
    if (!isAdmin && req.user?._id) {
      filter.$or = [
        { is_private: false },
        { is_private: { $exists: false } },
        { is_private: null },
        { created_by: req.user._id }
      ];
    }

    const bookmarks = await Bookmark.find(filter)
      .populate('client', 'company name')
      .populate('created_by', 'firstname lastname email')
      .sort({ createdAt: -1 });

    res.json(bookmarks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createBookmark = async (req, res) => {
  try {
    const { title, url, chromeBookmarkId, folder, client, is_private } = req.body;
    let tenant_id = req.user?.tenant_id;
    if (!tenant_id && req.user?.is_superadmin && req.body.tenant_id) {
      tenant_id = req.body.tenant_id;
    }
    
    if (!tenant_id) return res.status(400).json({ message: "Tenant ID required" });

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: "Bookmark title is required" });
    }

    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ message: "Invalid bookmark URL. Must start with http://, https://, or /" });
    }

    const cleanTitle = title.trim();
    const cleanUrl = url.trim();
    const cleanFolder = folder && typeof folder === 'string' && folder.trim() ? folder.trim() : "Uncategorized";
    const isPrivate = Boolean(is_private);

    // Check existing bookmark with same URL for this tenant
    const existing = await Bookmark.findOne({
      url: cleanUrl,
      tenant_id,
      ...(isPrivate ? { created_by: req.user?._id } : { is_private: { $ne: true } })
    });

    if (existing) {
      existing.title = cleanTitle;
      existing.folder = cleanFolder || existing.folder;
      if (client) existing.client = client;
      if (req.body.is_private !== undefined) existing.is_private = isPrivate;
      await existing.save();
      const populated = await Bookmark.findById(existing._id)
        .populate('client', 'company name')
        .populate('created_by', 'firstname lastname email');
      return res.status(200).json(populated);
    }

    const newBookmark = new Bookmark({
      title: cleanTitle,
      url: cleanUrl,
      chromeBookmarkId,
      folder: cleanFolder,
      client: client || undefined,
      created_by: req.user?._id,
      is_private: isPrivate,
      tenant_id
    });

    const savedBookmark = await newBookmark.save();
    const populated = await Bookmark.findById(savedBookmark._id)
      .populate('client', 'company name')
      .populate('created_by', 'firstname lastname email');
    res.status(201).json(populated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const syncBookmarks = async (req, res) => {
  try {
    const { bookmarks } = req.body;
    if (!bookmarks || !Array.isArray(bookmarks)) {
      return res.status(400).json({ message: "Invalid payload" });
    }
    
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(400).json({ message: "Tenant ID required" });

    const results = [];
    for (const b of bookmarks) {
      if (!b?.url || !isValidUrl(b.url)) continue;
      const cleanUrl = b.url.trim();
      const cleanTitle = (b.title && typeof b.title === 'string' ? b.title.trim() : cleanUrl) || "Untitled Bookmark";
      const cleanFolder = b.folder && typeof b.folder === 'string' && b.folder.trim() ? b.folder.trim() : "Bookmarks Bar";

      const existing = await Bookmark.findOne({ url: cleanUrl, tenant_id });

      if (!existing) {
        const newBookmark = new Bookmark({
          title: cleanTitle,
          url: cleanUrl,
          chromeBookmarkId: b.chromeBookmarkId,
          folder: cleanFolder,
          created_by: req.user?._id,
          tenant_id
        });
        await newBookmark.save();
        results.push(newBookmark);
      } else if (cleanFolder && existing.folder !== cleanFolder) {
        existing.folder = cleanFolder;
        await existing.save();
      }
    }
    
    res.status(201).json({ message: "Synced successfully", added: results.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteBookmark = async (req, res) => {
  try {
    let tenant_id = req.user?.tenant_id;
    if (!tenant_id && req.user?.is_superadmin && req.query.tenant_id) {
      tenant_id = req.query.tenant_id;
    }
    
    const bookmark = await Bookmark.findOne({ _id: req.params.id, ...(tenant_id ? { tenant_id } : {}) });
    if (!bookmark) {
      return res.status(404).json({ message: "Bookmark not found" });
    }

    const isAdmin = Boolean(req.user?.admin || req.user?.is_superadmin);
    const isOwner = bookmark.created_by && req.user?._id && bookmark.created_by.toString() === req.user._id.toString();

    // If bookmark has creator, only owner or admin can delete
    if (!isAdmin && bookmark.created_by && !isOwner) {
      return res.status(403).json({ message: "You can only delete your own bookmarks" });
    }

    await bookmark.deleteOne();
    res.json({ message: "Bookmark removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Clears every bookmark of the tenant (shared list), so admins only.
const deleteAllBookmarks = async (req, res) => {
  try {
    if (req.userRole !== "staff" || !req.user?.admin) {
      return res.status(403).json({ message: "Only an admin can delete all bookmarks" });
    }
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(400).json({ message: "Tenant ID required" });

    const result = await Bookmark.deleteMany({ tenant_id });
    res.json({ message: "All bookmarks removed", deleted: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteByChromeId = async (req, res) => {
  try {
    const { chromeId } = req.params;
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(400).json({ message: "Tenant ID required" });

    const filter = { chromeBookmarkId: chromeId, tenant_id };
    if (req.query.url) filter.url = String(req.query.url);
    const result = await Bookmark.deleteMany(filter);
    if (result.deletedCount > 0) {
      res.json({ message: "Bookmark removed from CRM" });
    } else {
      res.status(404).json({ message: "Bookmark not found in CRM" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateBookmark = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, url, folder, client, is_private } = req.body;
    let tenant_id = req.user?.tenant_id;
    if (!tenant_id && req.user?.is_superadmin && req.query.tenant_id) {
      tenant_id = req.query.tenant_id;
    }
    
    const bookmark = await Bookmark.findOne({ _id: id, ...(tenant_id ? { tenant_id } : {}) });
    if (!bookmark) {
      return res.status(404).json({ message: "Bookmark not found" });
    }

    const isAdmin = Boolean(req.user?.admin || req.user?.is_superadmin);
    const isOwner = bookmark.created_by && req.user?._id && bookmark.created_by.toString() === req.user._id.toString();

    if (!isAdmin && bookmark.created_by && !isOwner) {
      return res.status(403).json({ message: "You can only edit your own bookmarks" });
    }

    if (title !== undefined) {
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ message: "Bookmark title cannot be empty" });
      }
      bookmark.title = title.trim();
    }

    if (url !== undefined) {
      if (!isValidUrl(url)) {
        return res.status(400).json({ message: "Invalid bookmark URL. Must start with http://, https://, or /" });
      }
      bookmark.url = url.trim();
    }

    if (folder !== undefined) {
      bookmark.folder = typeof folder === 'string' && folder.trim() ? folder.trim() : "Uncategorized";
    }

    if (client !== undefined) {
      bookmark.client = client || null;
    }

    if (is_private !== undefined) {
      bookmark.is_private = Boolean(is_private);
    }

    await bookmark.save();
    const updated = await Bookmark.findById(bookmark._id)
      .populate('client', 'company name')
      .populate('created_by', 'firstname lastname email');
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  isValidUrl,
  getBookmarks,
  createBookmark,
  syncBookmarks,
  deleteBookmark,
  deleteAllBookmarks,
  deleteByChromeId,
  updateBookmark
};
