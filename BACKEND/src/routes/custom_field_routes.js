const express = require("express");
const router = express.Router();
const { getCustomFields, createCustomField, updateCustomField, deleteCustomField } = require("../controllers/custom_field_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(getCustomFields)
  .post(adminOnly, createCustomField);

router.route("/:id")
  .put(adminOnly, updateCustomField)
  .delete(adminOnly, deleteCustomField);

module.exports = router;
