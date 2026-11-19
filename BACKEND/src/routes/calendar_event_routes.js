const express = require("express");
const router = express.Router();
const calendarEventController = require("../controllers/calendar_event_controller");
const { protect } = require("../middleware/auth");

router.post("/", protect, calendarEventController.createEvent);
router.get("/", protect, calendarEventController.getEvents);
// Invoice/estimate/task… dates + reminders (Setup > Settings > Calendar).
router.get("/feed", protect, calendarEventController.getFeed);
router.put("/:id", protect, calendarEventController.updateEvent);
router.delete("/:id", protect, calendarEventController.deleteEvent);

module.exports = router;
