const express = require("express");
const router = express.Router();
const checklistController = require("../controllers/checklist_controller");

const { protect } = require("../middleware/auth_middleware");

router.get("/", protect, checklistController.getChecklist);
router.post("/toggle", protect, checklistController.toggleTask);
router.post("/task", protect, checklistController.createTask);
router.delete("/task/:id", protect, checklistController.deleteTask);

module.exports = router;
