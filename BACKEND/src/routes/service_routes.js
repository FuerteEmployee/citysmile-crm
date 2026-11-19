const express = require("express");
const router = express.Router();
const {
  getServices,
  createService,
  updateService,
  deleteService,
  bulkCreateService,
} = require("../controllers/service_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Support", "Create"), bulkCreateService);

router.route("/")
  .get(checkPermission("Support", "View"), getServices)
  .post(checkPermission("Support", "Create"), createService);

router.route("/:id")
  .put(checkPermission("Support", "Edit"), updateService)
  .delete(checkPermission("Support", "Delete"), deleteService);

module.exports = router;
