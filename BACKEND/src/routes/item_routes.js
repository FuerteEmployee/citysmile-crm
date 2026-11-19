const express = require("express");
const router = express.Router();
const { getItems, getItemById, createItem, updateItem, deleteItem, bulkDeleteItems, importItems } = require("../controllers/item_controller");
const { protect, checkPermission, requireCapability } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");

router.use(protect);

// Reads need Items View; writes need the matching Create / Edit / Delete
// capability (checkPermission only checks View).
router.route("/")
  .get(checkPermission("Items", "View"), getItems)
  .post(requireCapability("Items", "Create"), createItem);

router.post("/import", requireCapability("Items", "Create"), importItems);
router.post("/bulk-delete", requireCapability("Items", "Delete"), bulkDeleteItems);

router.route("/:id")
  .get(checkPermission("Items", "View"), validIdParam("id"), getItemById)
  .put(requireCapability("Items", "Edit"), validIdParam("id"), updateItem)
  .delete(requireCapability("Items", "Delete"), validIdParam("id"), deleteItem);

module.exports = router;
