const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const {
  getConditions,
  createCondition,
  updateCondition,
  deleteCondition,
} = require("../controllers/whatsapp_template_condition_controller");

router.use(protect, staffOnly, checkPermission("WhatsApp", "Edit"));

router.get("/", getConditions);
router.post("/", createCondition);
router.put("/:id", updateCondition);
router.delete("/:id", deleteCondition);

module.exports = router;
