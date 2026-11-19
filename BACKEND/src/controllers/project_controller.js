const Project = require("../models/Project");
const Client = require("../models/Client");
const CustomFieldService = require("../services/CustomFieldService");
const { logActivity } = require("../services/ActivityLogService");

// Mirrors the label/id pairs in Frontend/src/pages/Projects.tsx's `statusConfig`
// — keep these in sync if that list ever changes.
const PROJECT_STATUS_LABELS = [
  { id: 1, label: "not started" },
  { id: 2, label: "in progress" },
  { id: 3, label: "on hold" },
  { id: 4, label: "finished" },
  { id: 5, label: "cancelled" },
];

const enrichProjects = async (projects) => {
  const cfByProject = await CustomFieldService.getValuesForMany(projects.map((p) => p._id), "projects");
  return projects.map((project) => {
    const projectObj = project.toObject();
    projectObj.custom_fields = cfByProject.get(String(project._id)) || {};
    return projectObj;
  });
};

const getProjects = async (req, res) => {
  try {
    const filter = {};
    if (req.query.clientid) filter.clientid = req.query.clientid;
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;

    const { page, limit, search, status, branch } = req.query;
    const isPaginated = page !== undefined || limit !== undefined || search !== undefined;

    // Legacy behavior, unchanged: callers that don't ask for pagination
    // (client-tab project list, project pickers, exports) keep getting the
    // full bare array exactly as before.
    if (!isPaginated) {
      const projects = await Project.find(filter).populate("clientid");
      return res.json(await enrichProjects(projects));
    }

    if (search && String(search).trim()) {
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escapeRegExp(String(search).trim()), "i");
      const searchLower = String(search).trim().toLowerCase();

      // Customer is shown in the table by company name but stored as a ref —
      // resolve which clients match so that column is searchable too.
      const matchingClients = await Client.find({ company: re }).distinct("_id");
      // Status is a numeric enum shown in the table via a label (see
      // Frontend's `statusConfig`) — match the search text against those
      // labels and search by the matching numeric id(s).
      const matchingStatusIds = PROJECT_STATUS_LABELS.filter((s) => s.label.includes(searchLower)).map((s) => s.id);

      filter.$or = [
        { name: re },
        { description: re },
        { tags: re },
        { branch: re },
        { clientid: { $in: matchingClients } },
        { status: { $in: matchingStatusIds } },
      ];
    }
    if (status && status !== "all") filter.status = parseInt(status, 10);
    if (branch) filter.branch = branch;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 500);

    // Status-card counts always reflect the whole tenant/client scope,
    // independent of the currently active search/status/branch filters —
    // matches the same pattern used on Invoices/Leads/Tasks.
    const baseFilter = {};
    if (req.query.clientid) baseFilter.clientid = req.query.clientid;
    if (!req.user?.is_superadmin && req.user?.tenant_id) baseFilter.tenant_id = req.user.tenant_id;

    const [total, statusAgg, projects] = await Promise.all([
      Project.countDocuments(filter),
      Project.aggregate([{ $match: baseFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      Project.find(filter)
        .populate("clientid")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
    ]);

    res.json({
      data: await enrichProjects(projects),
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      limit: limitNum,
      statusAgg: statusAgg.map((s) => ({ status: s._id, count: s.count })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const projectScope = (req) => {
  const filter = { _id: req.params.id };
  if (!req.user?.is_superadmin && req.user?.tenant_id) {
    filter.tenant_id = req.user.tenant_id;
  }
  return filter;
};

const getProject = async (req, res) => {
  try {
    const project = await Project.findOne(projectScope(req)).populate("clientid");
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    
    const custom_fields_values = await CustomFieldService.getValues(project._id, "projects");
    const projectObj = project.toObject();
    projectObj.custom_fields = custom_fields_values;
    
    res.json(projectObj);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createProject = async (req, res) => {
  try {
    const projectData = { ...req.body };
    
    // Set creator info
    if (req.user) {
      projectData.addedfrom = req.user._id;
      projectData.created_by = req.user._id;
      projectData.tenant_id = req.user?.tenant_id;
    }
    
    // Ensure clientid is set (try various possible field names from frontend)
    const cid = projectData.clientid || projectData.clientId || projectData.client;
    if (cid) {
      projectData.clientid = cid;
    }

    // Double check if clientid is still missing
    if (!projectData.clientid) {
      return res.status(400).json({ message: "clientid is required" });
    }

    let project;
    try {
      project = await Project.create(projectData);
    } catch (dbError) {
      return res.status(400).json({ message: "DB Error: " + dbError.message });
    }

    if (project) {
      try {
        if (req.body.custom_fields) {
          await CustomFieldService.handlePost(project._id, "projects", req.body.custom_fields, project.tenant_id);
        }
      } catch (cfError) {
        console.error("Custom Fields Error:", cfError);
      }
      logActivity(req, `Created project: ${project.name}`, { rel_id: project._id, rel_type: "project" });
      return res.status(201).json(project.toObject ? project.toObject() : project);
    } else {
      return res.status(400).json({ message: "Invalid project data" });
    }
  } catch (error) {
    return res.status(400).json({ message: "Outer Catch Error: " + error.message });
  }
};

const updateProject = async (req, res) => {
  try {
    const project = await Project.findOne(projectScope(req));
    if (project) {
      Object.assign(project, req.body);
      const updatedProject = await project.save();
      logActivity(req, `Updated project: ${updatedProject.name}`, { rel_id: updatedProject._id, rel_type: "project" });
      res.json(updatedProject);
    } else {
      res.status(404).json({ message: "Project not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteProject = async (req, res) => {
  try {
    const project = await Project.findOne(projectScope(req));
    if (project) {
      const projectName = project.name;
      await project.deleteOne();
      logActivity(req, `Deleted project: ${projectName}`, { rel_type: "project" });
      res.json({ message: "Project removed" });
    } else {
      res.status(404).json({ message: "Project not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// One request, one deleteMany — replaces firing one DELETE per selected
// project from the browser (Promise.all over hundreds of ids), which
// overwhelmed the browser's per-host connection limit and felt like a hang
// under Bulk Actions on large project lists.
const bulkDeleteProjects = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ message: "No project ids provided" });

    const query = { _id: { $in: ids } };
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;

    const result = await Project.deleteMany(query);
    logActivity(req, `Bulk-deleted ${result.deletedCount} project(s)`, { rel_type: "project" });
    res.json({ message: `Deleted ${result.deletedCount} project(s)`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getProjects, getProject, createProject, updateProject, deleteProject, bulkDeleteProjects };
