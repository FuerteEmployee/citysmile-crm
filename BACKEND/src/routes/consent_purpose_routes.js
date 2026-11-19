const express = require("express");
const router = express.Router();
const {
  getPurposes,
  createPurpose,
  updatePurpose,
  deletePurpose,
} = require("../controllers/consent_purpose_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.route("/")
  .get(getPurposes)
  .post(adminOnly, createPurpose);

router.route("/:id")
  .put(adminOnly, updatePurpose)
  .delete(adminOnly, deletePurpose);

module.exports = router;
