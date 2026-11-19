const express = require("express");
const router = express.Router();
const { 
  getKBGroups, getKBArticles, 
  createKBArticle, createKBGroup,
  updateKBArticle, deleteKBArticle,
  updateKBGroup, deleteKBGroup
} = require("../controllers/kb_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.get("/groups", getKBGroups);
router.post("/groups", createKBGroup);
router.put("/groups/:id", updateKBGroup);
router.delete("/groups/:id", deleteKBGroup);

router.get("/articles", getKBArticles);
router.post("/articles", createKBArticle);
router.put("/articles/:id", updateKBArticle);
router.delete("/articles/:id", deleteKBArticle);

module.exports = router;
