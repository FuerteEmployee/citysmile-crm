const express = require("express");
const { controlAuth } = require("../middleware/controlAuth");
const control = require("../controllers/control_controller");

// Super Admin panel -> this CRM server (signed with CONTROL_SECRET, no login).
const router = express.Router();
router.use(controlAuth);

router.get("/status", control.getStatus);
router.get("/tenants/:id", control.getTenant);
router.put("/tenants/:id", control.updateTenant);

module.exports = router;
