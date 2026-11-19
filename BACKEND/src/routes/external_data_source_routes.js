const express = require("express");
const router = express.Router();
const {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  fetchData,
} = require("../controllers/external_data_source_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router
  .route("/")
  .get(checkPermission("Settings", "view"), listSources)
  .post(checkPermission("Settings", "create"), createSource);

router
  .route("/:id")
  .put(checkPermission("Settings", "edit"), updateSource)
  .delete(checkPermission("Settings", "delete"), deleteSource);

router.get("/:id/data", checkPermission("Settings", "view"), fetchData);

module.exports = router;
