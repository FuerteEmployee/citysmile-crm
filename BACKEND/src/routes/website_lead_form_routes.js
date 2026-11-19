const express = require("express");
const router = express.Router();
const { listForms, createForm, deleteForm } = require("../controllers/website_lead_form_controller");
const { protect, staffOnly, checkPermission } = require("../middleware/auth");

router.use(protect);
router.use(staffOnly);
router.use(checkPermission("Leads", "Edit"));

router.get("/", listForms);
router.post("/", createForm);
router.delete("/:id", deleteForm);

module.exports = router;
