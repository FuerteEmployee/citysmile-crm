const express = require("express");
const router = express.Router();
const { getTasks, getTaskById, createTask, updateTask, deleteTask, importTasks } = require("../controllers/task_controller");
const { protect, checkPermission, requireCapability } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");

router.use(protect);

router.route("/")
  .get(checkPermission("Tasks", "View"), getTasks)
  .post(requireCapability("Tasks", "Create"), createTask);

router.post("/import", requireCapability("Tasks", "Create"), importTasks);

router.route("/:id")
  .get(checkPermission("Tasks", "View"), validIdParam("id"), getTaskById)
  .put(requireCapability("Tasks", "Edit"), validIdParam("id"), updateTask)
  .delete(requireCapability("Tasks", "Delete"), validIdParam("id"), deleteTask);

module.exports = router;

