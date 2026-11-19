const express = require("express");
const router = express.Router();
const {
  upload,
  getModules,
  installModule,
  toggleModule,
  deleteModule,
} = require("../controllers/module_controller");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect);

router.get("/", getModules);
router.post("/install", adminOnly, upload.single("module"), installModule);
router.patch("/toggle", adminOnly, toggleModule);
router.delete("/:id", adminOnly, deleteModule);

module.exports = router;
