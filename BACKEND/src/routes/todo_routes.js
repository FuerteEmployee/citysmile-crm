const express = require("express");
const router = express.Router();
const { getTodos, createTodo, updateTodo, deleteTodo } = require("../controllers/todo_controller");
const { protect } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(getTodos)
  .post(createTodo);

router.route("/:id")
  .put(updateTodo)
  .delete(deleteTodo);

module.exports = router;
