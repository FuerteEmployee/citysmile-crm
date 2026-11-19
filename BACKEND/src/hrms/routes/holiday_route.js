const express = require("express");
const router = express.Router();
const holidayController = require("../controllers/holiday_controller");
const { protect, requireAdmin } = require("../middleware/auth_middleware");

router.use(protect);

// Everyone signed in may view the calendar (employees need it for the
// attendance screen); only admins may create/update/delete, matching the
// reference project's requirePermission("manage_holidays") gate.
router.get("/", holidayController.getHolidays);
router.get("/:id", holidayController.getHolidayById);
router.post("/", requireAdmin, holidayController.createHoliday);
router.put("/:id", requireAdmin, holidayController.updateHoliday);
router.delete("/:id", requireAdmin, holidayController.deleteHoliday);

module.exports = router;
