const express = require("express");
const router = express.Router();
const {
  getSidebarItems,
  createSidebarItem,
  updateSidebarItem,
  deleteSidebarItem,
  reorderSidebarItems
} = require("../controllers/mainsidebar_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(getSidebarItems)
  .post(checkPermission("Settings", "Create"), createSidebarItem);

// Must come before "/:id" — otherwise Express would match this as
// PUT /:id with id="reorder".
router.route("/reorder").put(checkPermission("Settings", "Edit"), reorderSidebarItems);

router.route("/:id")
  .put(checkPermission("Settings", "Edit"), updateSidebarItem)
  .delete(checkPermission("Settings", "Delete"), deleteSidebarItem);

module.exports = router;
