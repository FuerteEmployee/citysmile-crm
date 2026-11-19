const TodoTask = require("../models/todo_task_model");
const mongoose = require("mongoose");
const { getISTDate } = require("../utils/timeUtils");

exports.getTodos = async (req, res) => {
  try {
    const { 
      status, 
      priority, 
      category, 
      branchId, 
      franchiseId, 
      date, 
      userId 
    } = req.query;

    const query = { isActive: true, tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };

    if (status && status !== "all") {
      query.status = status;
    }
    if (priority && priority !== "all") {
      query.priority = priority;
    }
    if (category && category !== "all") {
      query.category = category;
    }
    if (branchId && branchId !== "all" && branchId !== "undefined") {
      query.branchId = new mongoose.Types.ObjectId(branchId);
    }
    if (franchiseId && franchiseId !== "all" && franchiseId !== "undefined") {
      query.franchiseId = new mongoose.Types.ObjectId(franchiseId);
    }
    if (userId && userId !== "all") {
      query.assignedTo = new mongoose.Types.ObjectId(userId);
    }

    if (date) {
      // Filter by due date matching the specific date, or if it has no due date but is pending
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      query.$or = [
        { dueDate: { $gte: startOfDay, $lte: endOfDay } },
        { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        { status: "Pending" } // Always show pending tasks regardless of date until they are completed or ignored
      ];
    }

    const tasks = await TodoTask.find(query).sort({ createdAt: -1 })
      .populate("branchId", "name")
      .populate("franchiseId", "name")
      .populate("assignedTo", "name");

    res.status(200).json({ success: true, data: tasks });
  } catch (error) {
    console.error("Error in getTodos:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateTodoStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["Pending", "In Progress", "Completed", "Ignored", "Snoozed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const updateData = { status };
    if (status === "Completed") {
      updateData.completedAt = new Date();
    } else {
      updateData.completedAt = null;
    }

    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const task = await TodoTask.findOneAndUpdate(
      { _id: id, ...tenantFilter },
      updateData,
      { new: true }
    );

    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    res.status(200).json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteTodo = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const task = await TodoTask.findOneAndUpdate({ _id: id, ...tenantFilter }, { isActive: false }, { new: true });
    
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    res.status(200).json({ success: true, message: "Task deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.triggerGenerator = async (req, res) => {
  try {
    // We will import this dynamically to avoid circular dependencies if any
    const { generateTodos } = require("../utils/todo_generator");
    await generateTodos();
    res.status(200).json({ success: true, message: "To-Do generator ran successfully" });
  } catch (error) {
    console.error("Error triggering generator:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
