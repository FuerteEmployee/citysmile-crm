const express = require("express");
const router = express.Router();
const {
  getPriorities,
  createPriority,
  updatePriority,
  deletePriority,
  bulkCreatePriority,
} = require("../controllers/priority_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Support", "Create"), bulkCreatePriority);

router
  .route("/")
  .get(checkPermission("Support", "View"), getPriorities)
  .post(checkPermission("Support", "Create"), createPriority);

router
  .route("/:id")
  .put(checkPermission("Support", "Edit"), updatePriority)
  .delete(checkPermission("Support", "Delete"), deletePriority);

module.exports = router;
