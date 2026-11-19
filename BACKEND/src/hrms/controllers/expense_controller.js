const Expense = require("../models/expense_model");
const { canActOnEmployee } = require("../utils/branchScope");

exports.createExpense = async (req, res) => {
  try {
    // Scope to the requester's own tenant — never trust a client-supplied tenant_id
    const tenant_id = req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null);

    const createdBy = req.user?.userId || req.user?.id || req.user?._id;

    const expense = new Expense({
      ...req.body,
      tenant_id,
      createdBy,
      status: "Pending" // Force pending on creation
    });
    if (req.file) {
      expense.receiptUrl = req.file.path;
    }
    await expense.save();
    res.status(201).json({ success: true, data: expense });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getExpenses = async (req, res) => {
  try {
    if (!req.user?.is_superadmin && !req.user?.tenant_id) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const { category, status, storeId, startDate, endDate, employeeId } = req.query;

    // Scope to the requester's own tenant — see auth_middleware.js's `protect`, which
    // resolves req.user.tenant_id for both the CRM-staff-bridged and native HRMS login paths.
    const tenantFilter = { tenant_id: req.user.is_superadmin ? null : req.user.tenant_id };

    let query = { ...tenantFilter };

    if (category) query.category = category;
    if (status) query.status = status;
    if (storeId) query.storeId = storeId;
    if (employeeId) query.createdBy = employeeId;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const rawExpenses = await Expense.find(query)
      .sort({ date: -1 })
      .populate("storeId", "name")
      .populate("approvedBy", "name email")
      .lean();

    const User = require("../models/user_model");
    const Staff = require("../../models/Staff");

    const creatorIds = rawExpenses.map((e) => e.createdBy).filter(Boolean);
    const [users, staffs] = await Promise.all([
      User.find({ _id: { $in: creatorIds } }).select("name email role avatar").lean(),
      Staff.find({ _id: { $in: creatorIds } }).select("firstname lastname email role").lean(),
    ]);

    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const staffMap = new Map(
      staffs.map((s) => [
        String(s._id),
        {
          _id: s._id,
          name: `${s.firstname} ${s.lastname || ""}`.trim(),
          email: s.email,
          role: s.role,
        },
      ])
    );

    const expenses = rawExpenses.map((exp) => {
      if (!exp.createdBy) {
        return { ...exp, createdBy: { name: "System" } };
      }
      const cId = String(exp.createdBy);
      const creator = userMap.get(cId) || staffMap.get(cId) || {
        _id: exp.createdBy,
        name: "Former Employee",
        isDeleted: true,
      };
      return { ...exp, createdBy: creator };
    });

    res.status(200).json({ success: true, count: expenses.length, data: expenses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getExpenseById = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const expense = await Expense.findOne({ _id: req.params.id, ...tenantFilter })
      .populate("storeId", "name")
      .populate("approvedBy", "name email")
      .lean();
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    if (expense.createdBy) {
      const User = require("../models/user_model");
      const Staff = require("../../models/Staff");
      const cId = expense.createdBy;
      const u = await User.findById(cId).select("name email role avatar").lean();
      if (u) {
        expense.createdBy = u;
      } else {
        const s = await Staff.findById(cId).select("firstname lastname email role").lean();
        if (s) {
          expense.createdBy = {
            _id: s._id,
            name: `${s.firstname} ${s.lastname || ""}`.trim(),
            email: s.email,
            role: s.role,
          };
        } else {
          expense.createdBy = { _id: cId, name: "Former Employee", isDeleted: true };
        }
      }
    } else {
      expense.createdBy = { name: "System" };
    }
    res.status(200).json({ success: true, data: expense });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    // Only allow updating basic fields, not status
    const updateData = { ...req.body };
    delete updateData.status;
    delete updateData.approvedBy;
    delete updateData.tenant_id; // never reassignable via this endpoint

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const expense = await Expense.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, updateData, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });
    res.status(200).json({ success: true, data: expense });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.updateExpenseStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const expense = await Expense.findOne({ _id: req.params.id, ...tenantFilter });
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });
    if (!["Pending", "Approved", "Paid", "Rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be Pending, Approved, Paid or Rejected" });
    }
    if (expense.createdBy && !(await canActOnEmployee(req, expense.createdBy, ["manage_expenses"]))) {
      return res.status(403).json({ success: false, message: "You don't have permission to approve this expense" });
    }

    expense.status = status;
    expense.approvedBy = req.user.userId;
    if (notes) expense.notes = notes;

    if (status === "Paid") {
      expense.paidAt = new Date();
    }

    await expense.save();
    res.status(200).json({ success: true, data: expense, message: `Expense ${status.toLowerCase()}` });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const expense = await Expense.findOne({ _id: req.params.id, ...tenantFilter });
    if (!expense) return res.status(404).json({ success: false, message: "Expense not found" });

    if (expense.status !== "Pending") {
      return res.status(400).json({ success: false, message: "Only pending expenses can be deleted" });
    }

    await expense.deleteOne();
    res.status(200).json({ success: true, message: "Expense deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
