const Task = require("../models/Task");
const Staff = require("../models/Staff");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");
const Setting = require("../models/Setting");

// Setup > Settings > Tasks as the backend uses them (own row, then global).
const TASK_STATUS_BY_KEY = { not_started: 1, in_progress: 2, testing: 3, awaiting_feedback: 4, complete: 5 };
const TASK_PRIORITY_BY_KEY = { low: 1, medium: 2, high: 3, urgent: 4 };
const isOn = (v) => v === true || v === 1 || v === "1" || v === "true";
const getTaskSettings = async (tenantId) => {
  const names = ["taskAllowStaffSeeAll", "taskAutoAssignCreator", "taskAutoAddFollower", "taskBillableDefault", "taskDefaultStatus", "taskDefaultPriority"];
  const rows = await Setting.find({ name: { $in: names }, $or: [{ tenant_id: tenantId || null }, { tenant_id: null }] }).lean();
  const value = (name) => {
    const own = tenantId ? rows.find((r) => r.name === name && String(r.tenant_id) === String(tenantId)) : null;
    return (own ?? rows.find((r) => r.name === name && r.tenant_id == null))?.value;
  };
  return {
    allowStaffSeeAll: isOn(value("taskAllowStaffSeeAll")),
    autoAssignCreator: isOn(value("taskAutoAssignCreator")),
    autoAddFollower: isOn(value("taskAutoAddFollower")),
    billableDefault: isOn(value("taskBillableDefault")),
    defaultStatus: String(value("taskDefaultStatus") || "not_started"),
    defaultPriority: String(value("taskDefaultPriority") || "medium"),
  };
};
/** "auto": In Progress when the start date is today or earlier, else Not Started. */
const defaultTaskStatus = (key, startdate) => {
  if (key !== "auto") return TASK_STATUS_BY_KEY[key] || 1;
  const start = startdate ? new Date(startdate) : new Date();
  return start.getTime() <= Date.now() ? 2 : 1;
};

// Staff with "View (Own)" see the tasks they created, are assigned to or
// follow — plus all project tasks when "Allow all staff to see all tasks
// related to projects" is on.
const taskOwnScope = async (req) => {
  if (req.permissionLevel !== "own") return null;
  const me = req.user._id;
  const or = [{ created_by: me }, { assignees: me }, { followers: me }];
  if ((await getTaskSettings(req.user?.tenant_id)).allowStaffSeeAll) or.push({ rel_type: "project" });
  return { $or: or };
};

// Mirrors Frontend/src/pages/Tasks.tsx's `taskStatusConfig` and
// `priorityLabels` — keep these in sync if those lists ever change.
const TASK_STATUS_LABELS = [
  { id: 1, label: "not started" },
  { id: 2, label: "in progress" },
  { id: 3, label: "testing" },
  { id: 4, label: "awaiting feedback" },
  { id: 5, label: "complete" },
];
const TASK_PRIORITY_LABELS = [
  { id: 1, label: "low" },
  { id: 2, label: "medium" },
  { id: 3, label: "high" },
  { id: 4, label: "urgent" },
];

const enrichTasks = async (tasks) => {
  const cfByTask = await CustomFieldService.getValuesForMany(tasks.map((t) => t._id), "tasks");
  return tasks.map((task) => {
    const taskObj = task.toObject();
    taskObj.custom_fields = cfByTask.get(String(task._id)) || {};
    return taskObj;
  });
};

const getTasks = async (req, res) => {
  try {
    const { rel_id, rel_type, page, limit, search, status, category, skip } = req.query;
    const filter = {};
    if (rel_id) filter.rel_id = rel_id;
    if (rel_type) filter.rel_type = rel_type;
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const ownScope = await taskOwnScope(req);
    if (ownScope) filter.$and = [ownScope];

    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (the customer/lead task tabs via rel_id/rel_type, dashboard/report
    // aggregation) keep getting the full bare array exactly as before.
    if (!isPaginated) {
      const tasks = await Task.find(filter);
      return res.json(await enrichTasks(tasks));
    }

    // Status-count cards always reflect the whole tenant/rel scope,
    // independent of the currently active search/status/category filters —
    // matches prior behavior (computed from the full, unfiltered task list).
    const baseFilter = { ...filter };

    const andConditions = ownScope ? [ownScope] : [];
    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const searchLower = String(search).trim().toLowerCase();

      // Assigned staff are shown in the table by name but stored as an array
      // of refs — resolve which staff match (scoped to the same tenant, same
      // idiom as Leads' assigned-staff match) so that column is searchable.
      const refScope = req.user?.is_superadmin ? {} : { tenant_id: req.user?.tenant_id };
      const matchedStaffIds = await Staff.find({
        ...refScope,
        $or: [{ firstname: re }, { lastname: re }],
      }).distinct("_id");

      // Status/Priority are numeric enums shown in the table via a label
      // (see Frontend's `taskStatusConfig`/`priorityLabels`) — match the
      // search text against those labels and search by the matching id(s).
      const matchedStatusIds = TASK_STATUS_LABELS.filter((s) => s.label.includes(searchLower)).map((s) => s.id);
      const matchedPriorityIds = TASK_PRIORITY_LABELS.filter((p) => p.label.includes(searchLower)).map((p) => p.id);

      andConditions.push({
        $or: [
          { name: re },
          { description: re },
          { category: re },
          { tags: re },
          { branch: re },
          { assignees: { $in: matchedStaffIds } },
          { status: { $in: matchedStatusIds } },
          { priority: { $in: matchedPriorityIds } },
        ],
      });
    }
    if (andConditions.length) filter.$and = andConditions;

    if (status && status !== "all") filter.status = parseInt(status, 10);
    if (category && category !== "all") {
      filter.category = category === "To-Do" ? { $in: ["To-Do", null] } : category;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);
    // `skip` lets a caller (the Tasks page, which interleaves a separate
    // Todo list after all tasks) request an exact offset instead of a page
    // number, when a page boundary falls in the middle of the task range.
    const skipNum = skip !== undefined ? Math.max(parseInt(skip, 10) || 0, 0) : (pageNum - 1) * limitNum;

    const [total, statusAgg, tasks] = await Promise.all([
      Task.countDocuments(filter),
      Task.aggregate([
        { $match: baseFilter },
        { $group: { _id: { $ifNull: ["$status", 1] }, count: { $sum: 1 } } },
      ]),
      Task.find(filter)
        .sort({ createdAt: -1 })
        .skip(skipNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichTasks(tasks),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      statusCounts: statusAgg.map((s) => ({ status: s._id, count: s.count })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getTaskById = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) {
      query.tenant_id = req.user.tenant_id;
    }
    const ownScope = await taskOwnScope(req);
    if (ownScope) query.$and = [ownScope];
    
    console.log("getTaskById query:", query, "user:", req.user?._id, "is_superadmin:", req.user?.is_superadmin);
    
    const task = await Task.findOne(query);
    if (!task) {
      console.log("getTaskById: Task not found for query:", query);
      return res.status(404).json({ message: "Task not found" });
    }
    
    const custom_fields_values = await CustomFieldService.getValues(task._id, "tasks");
    const taskObj = task.toObject();
    taskObj.custom_fields = custom_fields_values;
    
    res.json(taskObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createTask = async (req, res) => {
  const { custom_fields, ...taskData } = req.body;

  // Clean up empty string fields that cause Mongoose CastErrors
  if (taskData.rel_id === "") delete taskData.rel_id;
  if (taskData.related_to === "") {
    delete taskData.related_to;
    delete taskData.rel_type;
  }
  if (taskData.duedate === "") delete taskData.duedate;
  if (taskData.startdate === "") delete taskData.startdate;

  // Map related_to -> rel_type and rel_type_model
  if (taskData.related_to) {
    taskData.rel_type = taskData.related_to;
    if (taskData.related_to === 'customer') {
      taskData.rel_type_model = 'Client';
    } else if (taskData.related_to === 'project') {
      taskData.rel_type_model = 'Project';
    } else if (taskData.related_to === 'lead') {
      taskData.rel_type_model = 'Lead';
    } else {
      delete taskData.rel_type_model; // Ensure it doesn't fail enum validation
    }
  }
  
  if (taskData.category !== 'Inquiry' || !taskData.inquiry_outcome) {
    taskData.inquiry_outcome = null;
  }

  // Strip protected fields from user payload
  ["_id", "tenant_id", "created_by", "dateadded", "createdAt", "updatedAt"].forEach((f) => delete taskData[f]);

  if (req.user && req.user._id) {
    taskData.created_by = req.user._id;
  }

  try {
    // Setup > Settings > Tasks defaults for anything the caller did not send.
    const cfg = await getTaskSettings(req.user?.tenant_id);
    if (taskData.status === undefined || taskData.status === "") taskData.status = defaultTaskStatus(cfg.defaultStatus, taskData.startdate);
    if (taskData.priority === undefined || taskData.priority === "") taskData.priority = TASK_PRIORITY_BY_KEY[cfg.defaultPriority] || 2;
    if (taskData.billable === undefined) taskData.billable = cfg.billableDefault;
    const me = req.user?._id;
    if (me && cfg.autoAssignCreator && !(taskData.assignees || []).length) taskData.assignees = [me];
    if (me && cfg.autoAddFollower && !(taskData.followers || []).map(String).includes(String(me))) {
      taskData.followers = [...(taskData.followers || []), me];
    }
    if (Number(taskData.status) === 5 && !taskData.datefinished) {
      taskData.datefinished = new Date();
    }
    const task = await Task.create({ ...taskData, tenant_id: req.user?.tenant_id });

    if (task) {
      if (custom_fields) {
        await CustomFieldService.handlePost(task._id, "tasks", custom_fields, task.tenant_id);
      }
      logActivity(req, `Created task: ${task.name}`, { rel_id: task._id, rel_type: "task" });
      if (task.rel_type === "lead" && task.rel_id) {
        logActivity(req, `Added task: ${task.name}`, { rel_id: task.rel_id, rel_type: "lead" });
      }
      res.status(201).json(task);
    } else {
      res.status(400).json({ message: "Invalid task data" });
    }
  } catch (error) {
    console.error("Task Creation Error:", error);
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: error.message });
  }
};

const TASK_STATUS_MAP = {
  "not started": 1,
  "in progress": 2,
  "testing": 3,
  "awaiting feedback": 4,
  "complete": 5,
  "completed": 5,
};

const TASK_PRIORITY_MAP = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

const importTasks = async (req, res) => {
  try {
    const tasksData = Array.isArray(req.body) ? req.body : req.body.tasks;
    if (!tasksData || !Array.isArray(tasksData) || tasksData.length === 0) {
      return res.status(400).json({ message: "No valid task data provided" });
    }

    const tenantId = req.user?.tenant_id;

    const resolveStatus = (val) => {
      if (val === undefined || val === null || val === "") return 1;
      const num = Number(val);
      if (!isNaN(num) && num >= 1 && num <= 5) return num;
      return TASK_STATUS_MAP[String(val).toLowerCase().trim()] || 1;
    };

    const resolvePriority = (val) => {
      if (val === undefined || val === null || val === "") return 2;
      const num = Number(val);
      if (!isNaN(num) && num >= 1 && num <= 4) return num;
      return TASK_PRIORITY_MAP[String(val).toLowerCase().trim()] || 2;
    };

    const sanitizedTasks = tasksData
      .filter((t) => t && String(t.name || "").trim())
      .map((t) => ({
        name: String(t.name).trim(),
        description: t.description || "",
        status: resolveStatus(t.status),
        priority: resolvePriority(t.priority),
        startdate: t.startdate ? new Date(t.startdate) : undefined,
        duedate: t.duedate ? new Date(t.duedate) : undefined,
        tenant_id: tenantId,
        created_by: req.user?._id,
      }));

    if (sanitizedTasks.length === 0) {
      return res.status(400).json({ message: "No valid task rows found. Make sure a 'name' column exists." });
    }

    const result = await Task.insertMany(sanitizedTasks, { ordered: false });
    res.status(201).json({
      message: `Imported ${result.length} task(s).`,
      count: result.length,
    });
  } catch (error) {
    console.error("IMPORT TASKS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const updateTask = async (req, res) => {
  const { custom_fields, ...taskData } = req.body;

  // Clean up empty string fields that cause Mongoose CastErrors
  if (taskData.rel_id === "") delete taskData.rel_id;
  if (taskData.related_to === "") {
    delete taskData.related_to;
    delete taskData.rel_type;
  }
  if (taskData.duedate === "") delete taskData.duedate;
  if (taskData.startdate === "") delete taskData.startdate;

  // Map related_to -> rel_type and rel_type_model
  if (taskData.related_to) {
    taskData.rel_type = taskData.related_to;
    if (taskData.related_to === 'customer') {
      taskData.rel_type_model = 'Client';
    } else if (taskData.related_to === 'project') {
      taskData.rel_type_model = 'Project';
    } else if (taskData.related_to === 'lead') {
      taskData.rel_type_model = 'Lead';
    } else {
      delete taskData.rel_type_model;
    }
  }

  if (taskData.category && taskData.category !== 'Inquiry') {
    taskData.inquiry_outcome = null;
  } else if (taskData.inquiry_outcome === '') {
    taskData.inquiry_outcome = null;
  }

  // Strip protected fields from user payload
  ["_id", "tenant_id", "created_by", "dateadded", "createdAt", "updatedAt"].forEach((f) => delete taskData[f]);

  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    
    console.log("updateTask query:", query, "user:", req.user?._id, "is_superadmin:", req.user?.is_superadmin);
    
    const task = await Task.findOne(query);
    if (task) {
      // New comments (no _id yet) get their author.
      if (Array.isArray(taskData.comments) && req.user?._id) {
        taskData.comments = taskData.comments.map((c) => (c && !c._id && !c.added_by ? { ...c, added_by: req.user._id } : c));
      }
      // A new due date earns a new deadline reminder (Setup > Settings > Cron Job > Tasks).
      if (taskData.duedate !== undefined && String(new Date(taskData.duedate)) !== String(task.duedate)) taskData.deadline_notified = false;

      // Handle datefinished when status changes to/from Complete (5)
      if (taskData.status !== undefined) {
        const newStatus = Number(taskData.status);
        if (newStatus === 5 && task.status !== 5) {
          taskData.datefinished = new Date();
        } else if (task.status === 5 && newStatus !== 5) {
          taskData.datefinished = null;
        }
      }

      Object.assign(task, taskData);
      const updatedTask = await task.save();

      if (custom_fields) {
        await CustomFieldService.handlePost(task._id, "tasks", custom_fields, task.tenant_id);
      }

      logActivity(req, `Updated task: ${updatedTask.name}`, { rel_id: updatedTask._id, rel_type: "task" });

      res.json(updatedTask);
    } else {
      res.status(404).json({ message: "Task not found" });
    }
  } catch (error) {
    console.error("Task Update Error:", error);
    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: error.message });
  }
};

const deleteTask = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (!req.user?.is_superadmin) query.tenant_id = req.user?.tenant_id;
    const task = await Task.findOne(query);
    if (task) {
      const taskName = task.name;
      await task.deleteOne();
      logActivity(req, `Deleted task: ${taskName}`, { rel_type: "task" });
      res.json({ message: "Task removed" });
    } else {
      res.status(404).json({ message: "Task not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getTasks, getTaskById, createTask, updateTask, deleteTask, importTasks };
