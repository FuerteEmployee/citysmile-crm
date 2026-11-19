const express = require("express");
const router = express.Router();
const {
  getForms,
  getFormById,
  createForm,
  updateForm,
  deleteForm,
  submitForm,
} = require("../controllers/estimate_request_form_controller");
const { protect } = require("../middleware/auth");

// Public routes (no auth required)
router.get("/public/:id", getFormById);
router.post("/public/:id/submit", submitForm);

// Private routes
router.use(protect);

router.route("/").get(getForms).post(createForm);
router.route("/:id").get(getFormById).put(updateForm).delete(deleteForm);

module.exports = router;
