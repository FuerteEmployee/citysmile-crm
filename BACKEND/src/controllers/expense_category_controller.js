const ExpenseCategory = require("../models/ExpenseCategory");

const getExpenseCategories = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const categories = await ExpenseCategory.find(filter).sort({ name: 1 });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createExpenseCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Expense category name is required" });
    }

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const existing = await ExpenseCategory.findOne({ name: name.trim(), ...tenantFilter });
    if (existing) {
      return res.status(400).json({ message: "Expense category with this name already exists" });
    }

    const category = await ExpenseCategory.create({
      name: name.trim(),
      description: description?.trim() || "",
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(category);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateExpenseCategory = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const category = await ExpenseCategory.findOne({ _id: req.params.id, ...tenantFilter });

    if (!category) {
      return res.status(404).json({ message: "Expense category not found" });
    }

    const { name, description } = req.body;

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Expense category name cannot be empty" });
      }
      const existing = await ExpenseCategory.findOne({
        _id: { $ne: req.params.id },
        name: name.trim(),
        ...tenantFilter,
      });
      if (existing) {
        return res.status(400).json({ message: "Expense category with this name already exists" });
      }
      category.name = name.trim();
    }

    if (description !== undefined) {
      category.description = description ? description.trim() : "";
    }

    const updatedCategory = await category.save();
    res.json(updatedCategory);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteExpenseCategory = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const category = await ExpenseCategory.findOne({ _id: req.params.id, ...tenantFilter });

    if (!category) {
      return res.status(404).json({ message: "Expense category not found" });
    }

    await category.deleteOne();
    res.json({ message: "Expense category removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateExpenseCategory = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });
    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter((g) => g);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const toInsert = [];

    for (const name of validItems) {
      const existing = await ExpenseCategory.findOne({ name, ...tenantFilter });
      if (!existing && !toInsert.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
        toInsert.push({
          name,
          tenant_id: req.user?.tenant_id,
        });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "No new expense categories to add or all provided names already exist" });
    }

    const createdItems = await ExpenseCategory.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreateExpenseCategory,
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
};
