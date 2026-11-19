const Expense = require("../models/Expense");
const Client = require("../models/Client");
const Project = require("../models/Project");
const Invoice = require("../models/Invoice");

const getExpenses = async (req, res) => {
  try {
    const { client, project, search } = req.query;
    const filter = {};
    if (client) filter.client = client;
    if (project) filter.project = project;
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const [matchedProjectIds, matchedInvoiceIds] = await Promise.all([
        Project.find({ name: re }).distinct("_id"),
        Invoice.find({ number: re }).distinct("_id"),
      ]);
      filter.$or = [
        { expense_name: re },
        { category: re },
        { reference_no: re },
        { paymentmode: re },
        { project: { $in: matchedProjectIds } },
        { invoiceid: { $in: matchedInvoiceIds } },
      ];
    }

    const expenses = await Expense.find(filter).populate("client project invoiceid");
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createExpense = async (req, res) => {
  try {
    const expense = await Expense.create({ ...req.body, tenant_id: req.user?.tenant_id });
    res.status(201).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const expenseScope = (req) => {
  const filter = { _id: req.params.id };
  if (!req.user?.is_superadmin && req.user?.tenant_id) {
    filter.tenant_id = req.user.tenant_id;
  }
  return filter;
};

const deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findOneAndDelete(expenseScope(req));
    if (!expense) return res.status(404).json({ message: "Expense not found" });
    res.json({ message: "Expense deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateExpense = async (req, res) => {
  try {
    const expense = await Expense.findOneAndUpdate(expenseScope(req), req.body, { new: true });
    if (!expense) return res.status(404).json({ message: "Expense not found" });
    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getExpenses, createExpense, deleteExpense, updateExpense };
