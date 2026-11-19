const ContractType = require("../models/ContractType");

const getContractTypes = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const types = await ContractType.find(filter).sort({ name: 1 });
    res.json(types);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createContractType = async (req, res) => {
  try {
    const type = await ContractType.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(type);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateContractType = async (req, res) => {
  try {
    const type = await ContractType.findById(req.params.id);
    if (type) {
      Object.assign(type, req.body);
      const updatedType = await type.save();
      res.json(updatedType);
    } else {
      res.status(404).json({ message: "Contract Type not found" });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteContractType = async (req, res) => {
  try {
    const type = await ContractType.findById(req.params.id);
    if (type) {
      await type.deleteOne();
      res.json({ message: "Contract Type removed" });
    } else {
      res.status(404).json({ message: "Contract Type not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { 
  getContractTypes, 
  createContractType, 
  updateContractType, 
  deleteContractType 
};
