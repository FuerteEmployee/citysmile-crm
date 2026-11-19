const express = require("express");
const router = express.Router();
const { protect, staffOnly, checkPermission } = require("../middleware/auth");
const upload = require("../hrms/utils/cloudinary_config");
const {
  getInbox,
  replyToMessage,
  ignoreMessage,
  getConversations,
  getConversationMessages,
  getWindowStatus,
  getContactInfo,
  replyToConversation,
  sendTemplateToConversation,
} = require("../controllers/whatsapp_inbox_controller");

router.use(protect, staffOnly, checkPermission("WhatsApp", "View"));

router.get("/", getInbox);
router.post("/:id/reply", replyToMessage);
router.patch("/:id/ignore", ignoreMessage);

router.get("/conversations", getConversations);
router.get("/window/:mobile", getWindowStatus);
router.get("/contact/:mobile", getContactInfo);
router.get("/conversations/:mobile", getConversationMessages);
router.post("/conversations/:mobile/reply", upload.uploadMemory.single("file"), replyToConversation);
router.post("/conversations/:mobile/send-template", upload.uploadMemory.single("image"), sendTemplateToConversation);

module.exports = router;
