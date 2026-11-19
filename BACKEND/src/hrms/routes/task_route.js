const express = require("express");
const router = express.Router();
const taskController = require("../controllers/task_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/", taskController.createTask);
router.get("/", taskController.getAllTasks);
router.put("/:id", taskController.updateTask);
router.delete("/:id", taskController.deleteTask);

module.exports = router;
