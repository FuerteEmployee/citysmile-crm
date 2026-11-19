const express = require("express");
const router = express.Router();
const {
  getEstimateRequests,
  getEstimateRequestById,
  updateRequestStatus,
  createEstimateRequest,
  deleteEstimateRequest,
  updateEstimateRequest,
} = require("../controllers/estimate_request_controller.js");
const { protect, checkPermission } = require("../middleware/auth.js");

router.use(protect);
router.use(checkPermission("Estimate Request", "View"));

router.route("/")
  .get(getEstimateRequests)
  .post(createEstimateRequest);

router.route("/:id")
  .get(getEstimateRequestById)
  .put(updateEstimateRequest)
  .delete(deleteEstimateRequest);

router.patch("/:id/status", updateRequestStatus);

module.exports = router;
