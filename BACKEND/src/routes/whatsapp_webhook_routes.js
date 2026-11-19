const express = require("express");
const router = express.Router();
const { verifyWebhook, receiveWebhook } = require("../controllers/whatsapp_webhook_controller");

// Public — no protect/staffOnly. Meta's GET handshake carries only its own
// verify token (checked inside the controller); the POST payload's tenant is
// resolved from `metadata.phone_number_id`, same pattern as
// src/routes/webhook_routes.js's Meta Lead Ads webhook.
router.get("/", verifyWebhook);
router.post("/", receiveWebhook);

module.exports = router;
