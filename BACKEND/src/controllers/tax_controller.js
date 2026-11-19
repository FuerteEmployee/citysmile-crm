const Tax = require("../models/Tax");
const Item = require("../models/Item");
const { isObjectId } = require("../utils/requestSafety");

// Company scope: a tax can only be changed or removed by its own company.
const tenantFilterOf = (req) => (!req.user?.is_superadmin && req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {});

const getTaxes = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const taxes = await Tax.find(filter).sort({ name: 1 });
    res.json(taxes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createTax = async (req, res) => {
  try {
    const { taxrate } = req.body;
    const name = req.body.name === undefined ? undefined : String(req.body.name ?? "");
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Tax name is required" });
    }
    if (taxrate === undefined || taxrate === null || isNaN(Number(taxrate)) || Number(taxrate) < 0) {
      return res.status(400).json({ message: "Tax rate must be a non-negative number" });
    }

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const existing = await Tax.findOne({ name: name.trim(), ...tenantFilter });
    if (existing) {
      return res.status(400).json({ message: "Tax rate with this name already exists" });
    }

    const tax = await Tax.create({
      name: name.trim(),
      taxrate: Number(taxrate),
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(tax);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateTax = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Tax not found" });
    const tenantFilter = tenantFilterOf(req);
    const tax = await Tax.findOne({ _id: req.params.id, ...tenantFilter });

    if (!tax) {
      return res.status(404).json({ message: "Tax not found" });
    }

    const { taxrate } = req.body;
    const name = req.body.name === undefined ? undefined : String(req.body.name ?? "");
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Tax name cannot be empty" });
      }
      const existing = await Tax.findOne({
        _id: { $ne: req.params.id },
        name: name.trim(),
        ...tenantFilter,
      });
      if (existing) {
        return res.status(400).json({ message: "Tax rate with this name already exists" });
      }
      tax.name = name.trim();
    }

    if (taxrate !== undefined) {
      if (taxrate === null || isNaN(Number(taxrate)) || Number(taxrate) < 0) {
        return res.status(400).json({ message: "Tax rate must be a non-negative number" });
      }
      tax.taxrate = Number(taxrate);
    }

    const updatedTax = await tax.save();
    res.json(updatedTax);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteTax = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Tax not found" });
    const tenantFilter = tenantFilterOf(req);
    const tax = await Tax.findOne({ _id: req.params.id, ...tenantFilter });

    if (!tax) {
      return res.status(404).json({ message: "Tax not found" });
    }

    await tax.deleteOne();
    // Items keep no reference to a tax that no longer exists.
    const scope = tax.tenant_id ? { tenant_id: tax.tenant_id } : {};
    await Item.updateMany({ ...scope, tax: tax._id }, { $unset: { tax: 1 } });
    await Item.updateMany({ ...scope, tax2: tax._id }, { $unset: { tax2: 1 } });
    res.json({ message: "Tax removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateTax = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });
    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter((g) => g);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const toInsert = [];

    for (const item of validItems) {
      const parts = item.split("|");
      const name = parts[0].trim();
      const taxrate = parts[1] !== undefined ? parseFloat(parts[1]) : 0;
      if (!name) continue;
      if (isNaN(taxrate) || taxrate < 0) {
        return res.status(400).json({ message: `Invalid tax rate for ${name}: must be non-negative` });
      }
      const existing = await Tax.findOne({ name, ...tenantFilter });
      if (!existing && !toInsert.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
        toInsert.push({ name, taxrate, tenant_id: req.user?.tenant_id });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "No new tax rates to add or all provided names already exist" });
    }

    const createdItems = await Tax.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreateTax,
  getTaxes,
  createTax,
  updateTax,
  deleteTax,
};
