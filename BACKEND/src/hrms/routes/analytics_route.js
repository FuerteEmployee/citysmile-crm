const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth_middleware");
const { getInsights, refreshInsights } = require("../controllers/analytics_controller");

router.use(protect);

router.get("/insights",         getInsights);
router.post("/insights/refresh", refreshInsights);

module.exports = router;
