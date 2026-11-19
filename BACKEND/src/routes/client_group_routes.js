const express = require("express");
const router = express.Router();
const { getGroups, createGroup, updateGroup, deleteGroup, bulkCreateGroup } = require("../controllers/client_group_controller");
const { protect, checkPermission } = require("../middleware/auth");
const { validIdParam } = require("../utils/requestSafety");

// Customer groups use the Customers module permissions: View to list,
// Create / Edit / Delete (exact stored keys) to change them.
router.use(protect);
router.use(checkPermission("Customers", "View"));

router.post("/bulk", checkPermission("Customers", "Create"), bulkCreateGroup);

router.route("/")
  .get(checkPermission("Customers", "View"), getGroups)
  .post(checkPermission("Customers", "Create"), createGroup);

router.route("/:id")
  .all(validIdParam("id"))
  .put(checkPermission("Customers", "Edit"), updateGroup)
  .delete(checkPermission("Customers", "Delete"), deleteGroup);

module.exports = router;
