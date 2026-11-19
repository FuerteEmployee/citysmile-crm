const express = require("express");
const router = express.Router();
const { receiveLead } = require("../controllers/website_lead_form_controller");

// No auth — this is the endpoint external landing pages POST their form to.
router.post("/:key", receiveLead);

module.exports = router;
