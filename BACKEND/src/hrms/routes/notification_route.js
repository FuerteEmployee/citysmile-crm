const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth_middleware");
const {
  getMyNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} = require("../controllers/notification_controller");

router.get("/", protect, getMyNotifications);
router.get("/unread-count", protect, getUnreadCount);
router.patch("/read-all", protect, markAllRead);
router.patch("/:id/read", protect, markRead);

module.exports = router;
