const express = require("express");
const router = express.Router();
const { getEstimates, getEstimateById, createEstimate, updateEstimate, deleteEstimate, convertToInvoice, importEstimates, bulkDeleteEstimates } = require("../controllers/estimate_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { viewOrAssigned, nextNumberHandler } = require("../services/docSettings");

router.use(protect);
// Estimates "View", or (GET only) the estimates assigned to the staff member
// when Setup > Settings > Estimates > "Allow staff members to view estimates
// where they are assigned to" is on.
router.use(viewOrAssigned(checkPermission, "Estimates", "estimate"));

router.route("/")
  .get(getEstimates)
  .post(createEstimate);

router.get("/next-number", nextNumberHandler("estimate"));
router.post("/import", importEstimates);
router.post("/bulk-delete", checkPermission("Estimates", "Delete"), bulkDeleteEstimates);

router.route("/:id")
  .get(getEstimateById)
  .put(updateEstimate)
  .delete(deleteEstimate);

router.post("/:id/convert-to-invoice", convertToInvoice);

module.exports = router;
