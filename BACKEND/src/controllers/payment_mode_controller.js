const PaymentMode = require("../models/PaymentMode");

const getPaymentModes = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const modes = await PaymentMode.find(filter).sort({ name: 1 });
    res.json(modes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createPaymentMode = async (req, res) => {
  try {
    const {
      name,
      description,
      active,
      show_on_pdf,
      selected_by_default,
      invoices_only,
      expenses_only,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Payment mode name is required" });
    }

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const existing = await PaymentMode.findOne({ name: name.trim(), ...tenantFilter });
    if (existing) {
      return res.status(400).json({ message: "Payment mode with this name already exists" });
    }

    const mode = await PaymentMode.create({
      name: name.trim(),
      description: description?.trim() || "",
      active: active !== undefined ? Boolean(active) : true,
      show_on_pdf: Boolean(show_on_pdf),
      selected_by_default: Boolean(selected_by_default),
      invoices_only: Boolean(invoices_only),
      expenses_only: Boolean(expenses_only),
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(mode);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updatePaymentMode = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const mode = await PaymentMode.findOne({ _id: req.params.id, ...tenantFilter });

    if (!mode) {
      return res.status(404).json({ message: "Payment mode not found" });
    }

    const {
      name,
      description,
      active,
      show_on_pdf,
      selected_by_default,
      invoices_only,
      expenses_only,
    } = req.body;

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Payment mode name cannot be empty" });
      }
      const existing = await PaymentMode.findOne({
        _id: { $ne: req.params.id },
        name: name.trim(),
        ...tenantFilter,
      });
      if (existing) {
        return res.status(400).json({ message: "Payment mode with this name already exists" });
      }
      mode.name = name.trim();
    }

    if (description !== undefined) mode.description = description ? description.trim() : "";
    if (active !== undefined) mode.active = Boolean(active);
    if (show_on_pdf !== undefined) mode.show_on_pdf = Boolean(show_on_pdf);
    if (selected_by_default !== undefined) mode.selected_by_default = Boolean(selected_by_default);
    if (invoices_only !== undefined) mode.invoices_only = Boolean(invoices_only);
    if (expenses_only !== undefined) mode.expenses_only = Boolean(expenses_only);

    const updatedMode = await mode.save();
    res.json(updatedMode);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deletePaymentMode = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const mode = await PaymentMode.findOne({ _id: req.params.id, ...tenantFilter });

    if (!mode) {
      return res.status(404).json({ message: "Payment mode not found" });
    }

    await mode.deleteOne();
    res.json({ message: "Payment mode removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreatePaymentMode = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });
    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter((g) => g);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const toInsert = [];

    for (const name of validItems) {
      const existing = await PaymentMode.findOne({ name, ...tenantFilter });
      if (!existing && !toInsert.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
        toInsert.push({
          name,
          active: true,
          tenant_id: req.user?.tenant_id,
        });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "No new payment modes to add or all provided names already exist" });
    }

    const createdItems = await PaymentMode.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreatePaymentMode,
  getPaymentModes,
  createPaymentMode,
  updatePaymentMode,
  deletePaymentMode,
};
