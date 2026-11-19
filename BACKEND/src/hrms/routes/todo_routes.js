const express = require("express");
const router = express.Router();
const todoController = require("../controllers/todo_controller");
const { protect } = require("../middleware/auth_middleware");

router.get("/", protect, todoController.getTodos);
router.post("/generate", protect, todoController.triggerGenerator); // Manual trigger
router.patch("/:id/status", protect, todoController.updateTodoStatus);
router.delete("/:id", protect, todoController.deleteTodo);

module.exports = router;
