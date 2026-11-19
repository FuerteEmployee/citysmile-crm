const express = require("express");
const router = express.Router();
const {
  getAll,
  getDefault,
  getById,
  create,
  update,
  remove,
  analyzeSlipImage,
  uploadImage,
} = require("../controllers/salary_template_controller");
const { protect } = require("../middleware/auth_middleware");

router.use(protect);

router.get("/", getAll);
router.get("/default", getDefault);
router.get("/:id", getById);
router.post("/upload-image", uploadImage);
router.post("/analyze-slip", analyzeSlipImage);
router.post("/", create);
router.put("/:id", update);
router.delete("/:id", remove);

module.exports = router;
