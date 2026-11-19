const express = require("express");
const { hrmsManager } = require("../middleware/authorize");
const router = express.Router();
const shiftController = require("../controllers/shift_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.post("/", hrmsManager(["manage_shifts"]), shiftController.createShift);
router.get("/", shiftController.getAllShifts);
router.get("/:id", shiftController.getShiftById);
router.patch("/:id", hrmsManager(["manage_shifts"]), shiftController.updateShift);
router.post("/:id/assign", hrmsManager(["manage_shifts"]), shiftController.assignShift);
router.delete("/:id", hrmsManager(["manage_shifts"]), shiftController.deleteShift);

module.exports = router;
