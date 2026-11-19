const Todo = require("../models/Todo");

const getTodos = async (req, res) => {
  try {
    const filter = { staff: req.user._id };
    if (!req.user?.is_superadmin && req.user?.tenant_id) filter.tenant_id = req.user.tenant_id;
    const todos = await Todo.find(filter).sort({ todo_order: 1 });
    res.json(todos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createTodo = async (req, res) => {
  try {
    const todo = await Todo.create({
      ...req.body,
      staff: req.user._id,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(todo);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateTodo = async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (todo && todo.staff.toString() === req.user._id.toString()) {
      Object.assign(todo, req.body);
      if (req.body.finished && !todo.datefinished) {
        todo.datefinished = new Date();
      }
      const updatedTodo = await todo.save();
      res.json(updatedTodo);
    } else {
      res.status(404).json({ message: "Todo not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteTodo = async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id);
    if (todo && todo.staff.toString() === req.user._id.toString()) {
      await todo.deleteOne();
      res.json({ message: "Todo removed" });
    } else {
      res.status(404).json({ message: "Todo not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getTodos, createTodo, updateTodo, deleteTodo };
