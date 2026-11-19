const express = require("express");
const router = express.Router();
const { getGoals, getGoalOptions, getGoalById, createGoal, updateGoal, deleteGoal } = require("../controllers/goal_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Goals", "View"));

router.route("/")
  .get(getGoals)
  .post(checkPermission("Goals", "Create"), createGoal);

router.get("/options", getGoalOptions);

router.route("/:id")
  .get(getGoalById)
  .put(checkPermission("Goals", "Edit"), updateGoal)
  .delete(checkPermission("Goals", "Delete"), deleteGoal);

module.exports = router;
