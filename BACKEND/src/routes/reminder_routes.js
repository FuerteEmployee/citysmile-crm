const express = require("express");
const router = express.Router();
const {
  getReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  completeReminder,
  dismissReminder,
  reopenReminder,
} = require("../controllers/reminder_controller");
const { protect } = require("../middleware/auth");

router.use(protect);

router.get("/", getReminders);
router.post("/", createReminder);
router.patch("/:id/complete", completeReminder);
router.patch("/:id/dismiss", dismissReminder);
router.patch("/:id/reopen", reopenReminder);
router.put("/:id", updateReminder);
router.patch("/:id", updateReminder);
router.delete("/:id", deleteReminder);

module.exports = router;
