const ChecklistTask = require("../models/checklist_task_model");
const ChecklistStatus = require("../models/checklist_status_model");
const mongoose = require("mongoose");
const User = require("../models/user_model");
const { getISTDate } = require("../utils/timeUtils");


exports.getChecklist = async (req, res) => {
  try {
    const today = req.query.date || getISTDate();

    const userIdStr = req.query.userId || req.user?.userId;
    const storeIdStr = req.query.storeId;

    if (!userIdStr) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    const userId = new mongoose.Types.ObjectId(userIdStr);
    const user = await User.findById(userId);
    const roleId = user?.role;


    // 1. Get all active tasks
    const taskQuery = {
      isActive: true,
      $or: [
        { userId: userId },
        { isGlobal: true }
      ]
    };

    if (roleId) {
      taskQuery.$or.push({ roleId: roleId });
    }

    // If a specific store is selected, filter by that store OR global tasks
    if (storeIdStr && storeIdStr !== "all" && storeIdStr !== "undefined" && storeIdStr !== "null") {
      const storeId = new mongoose.Types.ObjectId(storeIdStr);
      taskQuery.storeId = { $in: [storeId, null, undefined] };
    }

    const tasks = await ChecklistTask.find(taskQuery);

    // 2. Get statuses for today for this user
    const statuses = await ChecklistStatus.find({
      userId: userId,
      date: today,
    });

    // 3. Merge them
    const dynamicChecklist = tasks.map(task => {
      const status = statuses.find(s => s.taskId.toString() === task._id.toString());
      return {
        id: task._id,
        task: task.task,
        category: task.category,
        storeId: task.storeId,
        userId: task.userId,
        roleId: task.roleId,
        isGlobal: task.isGlobal,
        completed: status ? status.completed : false,
        statusId: status ? status._id : null
      };
    });

    res.status(200).json({ success: true, data: dynamicChecklist });

  } catch (error) {
    console.error("DEBUG: Error in getChecklist:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.toggleTask = async (req, res) => {
  try {
    const { taskId, completed, date } = req.body;
    const userId = req.user.userId;

    const today = date || getISTDate();


    const status = await ChecklistStatus.findOneAndUpdate(
      { taskId, userId, date: today },
      {
        completed,
        completedAt: completed ? new Date() : null
      },
      { upsert: true, returnDocument: 'after' }
    );

    res.status(200).json({ success: true, data: status });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.createTask = async (req, res) => {
  try {
    const taskData = { ...req.body };
    // If neither userId nor roleId is provided, default to the current user's personal task
    if (!taskData.userId && !taskData.roleId && !taskData.isGlobal) {
      taskData.userId = req.user.userId;
    }

    const task = new ChecklistTask(taskData);
    await task.save();
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const task = await ChecklistTask.findById(id);

    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // Only allow the creator or an admin to delete
    if (task.userId && task.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this task" });
    }


    await ChecklistTask.findByIdAndDelete(id);
    // Also delete any statuses associated with this task
    await ChecklistStatus.deleteMany({ taskId: id });

    res.status(200).json({ success: true, message: "Task deleted successfully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
