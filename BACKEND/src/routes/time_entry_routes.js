const express = require("express");
const router = express.Router();
const timeEntryController = require("../controllers/time_entry_controller");
const { protect } = require("../middleware/auth");

router.post("/", protect, timeEntryController.createTimeEntry);
router.get("/", protect, timeEntryController.getTimeEntries);
router.put("/:id", protect, timeEntryController.updateTimeEntry);
router.delete("/:id", protect, timeEntryController.deleteTimeEntry);

module.exports = router;
