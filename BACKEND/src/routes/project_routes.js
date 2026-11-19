const express = require("express");
const router = express.Router();
const { getProjects, getProject, createProject, updateProject, deleteProject, bulkDeleteProjects } = require("../controllers/project_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Projects", "View"));

router.route("/")
  .get(getProjects)
  .post(createProject);

router.post("/bulk-delete", checkPermission("Projects", "Delete"), bulkDeleteProjects);

router.route("/:id")
  .get(getProject)
  .put(updateProject)
  .delete(deleteProject);

module.exports = router;
