const express = require("express");
const router = express.Router();
const {
  sendChatMessage,
  getChatHistory,
  getChatStaff,
  deleteChatMessage,
  markAsRead,
  createGroupChat,
  addGroupMember,
  exitGroupChat,
  deleteGroupChat,
} = require("../controllers/chat_controller");
const { protect, staffOnly } = require("../middleware/auth");

// All chat routes are for staff only
router.use(protect);
router.use(staffOnly);

router.get("/staff", getChatStaff);
router.get("/history/:userId", getChatHistory);
router.post("/send", sendChatMessage);
router.delete("/message/:id", deleteChatMessage);
router.put("/read/:userId", markAsRead);
router.post("/group", createGroupChat);
router.put("/group/:groupId/add", addGroupMember);
router.put("/group/:groupId/exit", exitGroupChat);
router.delete("/group/:groupId", deleteGroupChat);

module.exports = router;
