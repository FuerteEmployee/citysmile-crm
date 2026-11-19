const Department = require("../models/Department");
const Ticket = require("../models/Ticket");

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getDepartments = async (req, res) => {
  try {
    const filter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const departments = await Department.find(filter).sort({ name: 1 });

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;

    const departmentsWithCount = await Promise.all(
      departments.map(async (dept) => {
        const totalTickets = await Ticket.countDocuments({ ...ticketScope, department: dept._id });
        return {
          ...dept.toObject(),
          totalTickets,
        };
      })
    );

    res.json(departmentsWithCount);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createDepartment = async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ message: "Department name is required" });
    }

    const trimmedName = String(rawName).trim();

    const existing = await Department.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
      tenant_id: req.user?.tenant_id,
    });

    if (existing) {
      return res.status(400).json({ message: "A department with this name already exists" });
    }

    const department = await Department.create({
      ...req.body,
      name: trimmedName,
      tenant_id: req.user?.tenant_id,
    });

    res.status(201).json({
      ...department.toObject(),
      totalTickets: 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateDepartment = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const department = await Department.findOne(filter);
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }

    if (req.body.name !== undefined) {
      const trimmedName = String(req.body.name).trim();
      if (!trimmedName) {
        return res.status(400).json({ message: "Department name is required" });
      }

      const duplicate = await Department.findOne({
        _id: { $ne: department._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, "i") },
        tenant_id: req.user?.tenant_id,
      });

      if (duplicate) {
        return res.status(400).json({ message: "A department with this name already exists" });
      }

      req.body.name = trimmedName;
    }

    Object.assign(department, req.body);
    const updatedDepartment = await department.save();

    const ticketScope = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) ticketScope.tenant_id = req.user.tenant_id;
    const totalTickets = await Ticket.countDocuments({ ...ticketScope, department: updatedDepartment._id });

    res.json({
      ...updatedDepartment.toObject(),
      totalTickets,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteDepartment = async (req, res) => {
  try {
    const filter = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const department = await Department.findOne(filter);
    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }

    const ticketCount = await Ticket.countDocuments({ department: department._id });
    if (ticketCount > 0) {
      return res.status(400).json({ message: "Cannot delete department with active tickets" });
    }

    await department.deleteOne();
    res.json({ message: "Department removed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const bulkCreateDepartment = async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ message: "Invalid items data" });

    const validItems = items.map((g) => (typeof g === "string" ? g.trim() : "")).filter(Boolean);
    if (validItems.length === 0) return res.status(400).json({ message: "No valid item names provided" });

    const existing = await Department.find({
      name: { $in: validItems.map((g) => new RegExp(`^${escapeRegex(g)}$`, "i")) },
      tenant_id: req.user?.tenant_id,
    }).select("name");

    const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const toInsert = [];
    const seen = new Set();

    for (const name of validItems) {
      const lower = name.toLowerCase();
      if (!existingNames.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        toInsert.push({ name, tenant_id: req.user?.tenant_id });
      }
    }

    if (toInsert.length === 0) {
      return res.status(400).json({ message: "All specified departments already exist" });
    }

    const createdItems = await Department.insertMany(toInsert);
    res.status(201).json(createdItems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  bulkCreateDepartment,
};
