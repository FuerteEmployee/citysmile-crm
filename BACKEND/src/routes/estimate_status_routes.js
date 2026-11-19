const express = require("express");
const router = express.Router();
const {
  getEstimateStatuses,
  createEstimateStatus,
  updateEstimateStatus,
  deleteEstimateStatus,
} = require("../controllers/estimate_status_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.get("/", getEstimateStatuses);
router.post("/", adminOnly, createEstimateStatus);
router.put("/:id", adminOnly, updateEstimateStatus);
router.delete("/:id", adminOnly, deleteEstimateStatus);

module.exports = router;
