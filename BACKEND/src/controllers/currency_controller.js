const Currency = require("../models/Currency");

const getCurrencies = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const currencies = await Currency.find(filter).sort({ name: 1 });
    res.json(currencies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createCurrency = async (req, res) => {
  try {
    const { name, symbol, decimal_separator, thousand_separator, placement, isdefault } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Currency code/name is required" });
    }
    if (!symbol || !symbol.trim()) {
      return res.status(400).json({ message: "Currency symbol is required" });
    }

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const existing = await Currency.findOne({ name: name.trim(), ...tenantFilter });
    if (existing) {
      return res.status(400).json({ message: "Currency with this code already exists" });
    }

    if (isdefault) {
      await Currency.updateMany(tenantFilter, { isdefault: false });
    }

    const currency = await Currency.create({
      name: name.trim().toUpperCase(),
      symbol: symbol.trim(),
      decimal_separator: decimal_separator ?? ".",
      thousand_separator: thousand_separator ?? ",",
      placement: placement === "after" ? "after" : "before",
      isdefault: Boolean(isdefault),
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(currency);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateCurrency = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const currency = await Currency.findOne({ _id: req.params.id, ...tenantFilter });

    if (!currency) {
      return res.status(404).json({ message: "Currency not found" });
    }

    const { name, symbol, decimal_separator, thousand_separator, placement, isdefault } = req.body;

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Currency code/name cannot be empty" });
      }
      const existing = await Currency.findOne({
        _id: { $ne: req.params.id },
        name: name.trim().toUpperCase(),
        ...tenantFilter,
      });
      if (existing) {
        return res.status(400).json({ message: "Currency with this code already exists" });
      }
      currency.name = name.trim().toUpperCase();
    }

    if (symbol !== undefined) {
      if (!symbol || !symbol.trim()) {
        return res.status(400).json({ message: "Currency symbol cannot be empty" });
      }
      currency.symbol = symbol.trim();
    }

    if (decimal_separator !== undefined) currency.decimal_separator = decimal_separator;
    if (thousand_separator !== undefined) currency.thousand_separator = thousand_separator;
    if (placement !== undefined) currency.placement = placement === "after" ? "after" : "before";

    if (isdefault !== undefined) {
      if (isdefault) {
        await Currency.updateMany({ _id: { $ne: req.params.id }, ...tenantFilter }, { isdefault: false });
        currency.isdefault = true;
      } else {
        // If unsetting default, only allow if another currency is default or allow unsetting
        currency.isdefault = false;
      }
    }

    const updatedCurrency = await currency.save();
    res.json(updatedCurrency);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteCurrency = async (req, res) => {
  try {
    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const currency = await Currency.findOne({ _id: req.params.id, ...tenantFilter });

    if (!currency) {
      return res.status(404).json({ message: "Currency not found" });
    }

    if (currency.isdefault) {
      return res.status(400).json({ message: "Cannot delete base currency" });
    }

    await currency.deleteOne();
    res.json({ message: "Currency removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateCurrency = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });
    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter((g) => g);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const tenantFilter = req.user?.tenant_id ? { tenant_id: req.user.tenant_id } : {};
    const toInsert = [];

    for (const item of validItems) {
      const parts = item.split("|");
      const name = parts[0].trim().toUpperCase();
      const symbol = parts[1] ? parts[1].trim() : "$";
      if (!name) continue;

      const existing = await Currency.findOne({ name, ...tenantFilter });
      if (!existing && !toInsert.some((x) => x.name === name)) {
        toInsert.push({
          name,
          symbol,
          tenant_id: req.user?.tenant_id,
        });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "No new currencies to add or all provided codes already exist" });
    }

    const createdItems = await Currency.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  bulkCreateCurrency,
  getCurrencies,
  createCurrency,
  updateCurrency,
  deleteCurrency,
};
