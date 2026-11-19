const express = require("express");
const router = express.Router();
const templateController = require("../controllers/email_template_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(templateController.getTemplates)
  .post(adminOnly, templateController.createTemplate);

router.route("/:id")
  .get(templateController.getTemplateById)
  .put(adminOnly, templateController.updateTemplate)
  .patch(adminOnly, templateController.updateTemplate)
  .delete(adminOnly, templateController.deleteTemplate);

module.exports = router;
