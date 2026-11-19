const express = require("express");
const router = express.Router();
const { getRoles, createRole, updateRole, deleteRole } = require("../controllers/role_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(checkPermission("Staff Roles", "View"));

router.route("/")
  .get(getRoles)
  .post(createRole);

router.route("/:id")
  .put(updateRole)
  .delete(deleteRole);

module.exports = router;
