  const express = require("express");
  const router = express.Router();
  const roleController = require("../controllers/role_controller");
  const { protect } = require("../middleware/auth_middleware");

  router.get("/", protect, roleController.getRoles);
  router.post("/", protect, roleController.createRole);
  router.put("/:id", protect, roleController.updateRole);
  router.delete("/:id", protect, roleController.deleteRole);

  module.exports = router;
