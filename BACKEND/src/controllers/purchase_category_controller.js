const PurchaseCategory = require("../models/PurchaseCategory");
const Item = require("../models/Item");
const Purchase = require("../models/Purchase");

// Calculate path and level helper
function computePathAndLevel(parent, procurementType, code) {
  if (!parent) {
    // Root level under procurement type (Level 2 in the 4-level tree: Type -> Category -> Subcategory -> Item)
    return {
      procurementType,
      path: `${procurementType}/${code}`,
      level: 2,
    };
  }

  // Child inherits procurement type from parent (Rule 1 & Test U2)
  const childType = parent.procurementType;
  const childLevel = parent.level + 1;

  if (childLevel > 4) {
    const error = new Error("The category tree is limited to a maximum of 4 levels");
    error.status = 400;
    throw error;
  }

  return {
    procurementType: childType,
    path: `${parent.path}/${code}`,
    level: childLevel,
  };
}

// GET /api/purchase-categories
const listCategories = async (req, res) => {
  try {
    const { type, parentId, includeInactive } = req.query;
    const filter = { tenant_id: req.user.tenant_id };

    if (type) {
      filter.procurementType = String(type).toUpperCase();
    }

    if (parentId !== undefined) {
      filter.parentId = parentId === "null" || !parentId ? null : parentId;
    }

    if (!includeInactive || includeInactive === "false") {
      filter.isActive = true;
    }

    const categories = await PurchaseCategory.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    return res.json({ success: true, count: categories.length, categories });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// GET /api/purchase-categories/:id
const getCategory = async (req, res) => {
  try {
    const category = await PurchaseCategory.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.json({ success: true, category });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /api/purchase-categories
const createCategory = async (req, res) => {
  try {
    const { name, code, procurementType, parentId, sortOrder } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Category name is required" });
    }

    if (!code || !String(code).trim()) {
      return res.status(400).json({ message: "Category code is required" });
    }

    const cleanCode = String(code).trim().toUpperCase();

    // Check unique code per tenant (Test N3)
    const existing = await PurchaseCategory.findOne({
      tenant_id: req.user.tenant_id,
      code: cleanCode,
    });
    if (existing) {
      return res.status(409).json({ message: "Code already exists" });
    }

    let parent = null;
    if (parentId) {
      parent = await PurchaseCategory.findOne({
        _id: parentId,
        tenant_id: req.user.tenant_id,
      });
      if (!parent) {
        return res.status(404).json({ message: "Parent category not found" });
      }
    }

    const reqType = procurementType ? String(procurementType).trim().toUpperCase() : "READY";
    const { procurementType: finalType, path, level } = computePathAndLevel(
      parent,
      reqType,
      cleanCode
    );

    const category = await PurchaseCategory.create({
      name: String(name).trim(),
      code: cleanCode,
      procurementType: finalType,
      parentId: parent ? parent._id : null,
      path,
      level,
      sortOrder: Number(sortOrder) || 0,
      createdBy: req.user._id,
      tenant_id: req.user.tenant_id,
    });

    return res.status(201).json({ success: true, category });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// PUT /api/purchase-categories/:id
const updateCategory = async (req, res) => {
  try {
    const { name, sortOrder } = req.body;
    const category = await PurchaseCategory.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    if (name) category.name = String(name).trim();
    if (sortOrder !== undefined) category.sortOrder = Number(sortOrder) || 0;

    await category.save();

    return res.json({ success: true, category });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// PATCH /api/purchase-categories/:id/archive
const archiveCategory = async (req, res) => {
  try {
    const category = await PurchaseCategory.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Check if category has items (Test I3)
    const itemCount = await Item.countDocuments({
      tenant_id: req.user.tenant_id,
      $or: [{ categoryId: category._id }, { subcategoryId: category._id }],
    });

    if (itemCount > 0) {
      return res.status(409).json({
        message: "Cannot archive category that has items associated with it",
      });
    }

    category.isActive = false;
    await category.save();

    return res.json({ success: true, message: "Category archived", category });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  computePathAndLevel,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  archiveCategory,
};

