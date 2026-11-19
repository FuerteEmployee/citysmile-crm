const BankDetail = require("../models/BankDetail");

const getBankDetails = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const bankDetails = await BankDetail.find(filter).populate("branch").sort({ createdAt: -1 });
    res.json(bankDetails);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createBankDetail = async (req, res) => {
  try {
    const bankDetail = await BankDetail.create({ ...req.body, tenant_id: req.user?.tenant_id });
    const populated = await BankDetail.findById(bankDetail._id).populate("branch");
    res.status(201).json(populated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateBankDetail = async (req, res) => {
  try {
    const bankDetail = await BankDetail.findById(req.params.id);
    if (bankDetail) {
      Object.assign(bankDetail, req.body);
      await bankDetail.save();
      const updated = await BankDetail.findById(bankDetail._id).populate("branch");
      res.json(updated);
    } else {
      res.status(404).json({ message: "Bank detail not found" });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteBankDetail = async (req, res) => {
  try {
    const bankDetail = await BankDetail.findById(req.params.id);
    if (bankDetail) {
      await bankDetail.deleteOne();
      res.json({ message: "Bank detail removed" });
    } else {
      res.status(404).json({ message: "Bank detail not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getBankDetails,
  createBankDetail,
  updateBankDetail,
  deleteBankDetail,
};
