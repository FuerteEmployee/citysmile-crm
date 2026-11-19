const express = require("express");
const router = express.Router();
const replyController = require("../controllers/predefined_reply_controller");
const { protect, checkPermission } = require("../middleware/auth");

router.use(protect);

router.post("/bulk", checkPermission("Support", "Create"), replyController.bulkCreateReply);

router.route("/")
  .get(checkPermission("Support", "View"), replyController.getReplies)
  .post(checkPermission("Support", "Create"), replyController.createReply);

router.route("/:id")
  .put(checkPermission("Support", "Edit"), replyController.updateReply)
  .patch(checkPermission("Support", "Edit"), replyController.updateReply)
  .delete(checkPermission("Support", "Delete"), replyController.deleteReply);

module.exports = router;
