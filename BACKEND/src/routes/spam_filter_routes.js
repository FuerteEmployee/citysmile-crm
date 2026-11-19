const express = require("express");
const router = express.Router();
const {
  getSpamFilters,
  createSpamFilter,
  updateSpamFilter,
  deleteSpamFilter,
} = require("../controllers/spam_filter_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(checkPermission("Support", "View"), getSpamFilters)
  .post(checkPermission("Support", "Create"), createSpamFilter);

router.route("/:id")
  .put(checkPermission("Support", "Edit"), updateSpamFilter)
  .delete(checkPermission("Support", "Delete"), deleteSpamFilter);

module.exports = router;
