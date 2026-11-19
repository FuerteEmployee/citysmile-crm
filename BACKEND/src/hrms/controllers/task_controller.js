// HRMS Tasks intentionally share the main CRM's Task collection (see
// src/models/Task.js) — there is only one Task dataset in the system.
const Task = require("../../models/Task");

exports.createTask = async (req, res) => {
  try {
    const taskData = {
      ...req.body,
      followers: req.body.followers || [],
      tenant_id: req.user?.is_superadmin ? (req.body.tenant_id || null) : (req.user?.tenant_id || null),
    };
    const task = new Task(taskData);
    await task.save();
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getAllTasks = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const tasks = await Task.find(tenantFilter)
      .populate("assignees", "firstname lastname email")
      .populate("followers", "firstname lastname email");
    res.status(200).json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateTask = async (req, res) => {
  try {
    console.log("Updating task:", req.params.id, "Body:", JSON.stringify(req.body, null, 2));
    
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const body = { ...req.body };
    delete body.tenant_id; // never reassignable via this endpoint
    let task = await Task.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      body,
      { returnDocument: "after", runValidators: true }
    );
    
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    
    // Explicitly populate for the response
    task = await Task.findById(task._id)
      .populate("assignees", "firstname lastname email")
      .populate("followers", "firstname lastname email");

    res.status(200).json({ success: true, data: task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const tenantFilter = { tenant_id: req.user?.is_superadmin ? null : (req.user?.tenant_id || null) };
    const task = await Task.findOneAndDelete({ _id: req.params.id, ...tenantFilter });
    if (!task) return res.status(404).json({ success: false, message: "Task not found" });
    res.status(200).json({ success: true, message: "Task deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
