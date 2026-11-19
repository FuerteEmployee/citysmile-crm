const ExpenseCategory = require("../models/expense_category_model");

// A company sees its own categories plus the shared ones (tenant_id null).
const tenantOf = (req) => (req.user?.is_superadmin ? null : (req.user?.tenant_id || null));
const visibleTo = (req) => ({ tenant_id: { $in: [tenantOf(req), null] } });

exports.getAll = async (req, res) => {
  try {
    const categories = await ExpenseCategory.find({ isActive: true, ...visibleTo(req) }).sort({ name: 1 });
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const tenant_id = tenantOf(req);
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Category name is required" });
    if (await ExpenseCategory.exists({ tenant_id, name })) {
      return res.status(400).json({ success: false, message: "An expense category with this name already exists." });
    }
    const category = new ExpenseCategory({ ...req.body, name, tenant_id });
    await category.save();
    res.status(201).json({ success: true, data: category });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "An expense category with this name already exists." });
    }
    res.status(400).json({ message: error.message });
  }
};

// Only the company's own categories can be edited or deleted — never a shared one or another company's.
exports.update = async (req, res) => {
  try {
    const body = { ...req.body };
    delete body.tenant_id;
    const category = await ExpenseCategory.findOneAndUpdate(
      { _id: req.params.id, tenant_id: tenantOf(req) },
      body,
      { returnDocument: "after" }
    );
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    res.json({ success: true, data: category });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "An expense category with this name already exists." });
    }
    res.status(400).json({ message: error.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const category = await ExpenseCategory.findOneAndDelete({ _id: req.params.id, tenant_id: tenantOf(req) });
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    res.json({ message: "Category deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
