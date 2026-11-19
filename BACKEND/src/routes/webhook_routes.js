const express = require("express");
const router = express.Router();
const { verifyWebhook, receiveWebhook } = require("../controllers/webhook_controller");

// Verification endpoint for Meta (GET) and handler for new lead notifications (POST)
router.route("/meta-leads")
  .get(verifyWebhook)
  .post(receiveWebhook);

module.exports = router;
