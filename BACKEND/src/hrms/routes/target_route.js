const express = require("express");
const router = express.Router();
const targetController = require("../controllers/target_controller");
const { protect } = require("../middleware/auth_middleware");

router.get("/", protect, targetController.getTargets);
router.post("/", protect, targetController.createTarget);
router.put("/:id", protect, targetController.updateTarget);
router.delete("/:id", protect, targetController.deleteTarget);

module.exports = router;
