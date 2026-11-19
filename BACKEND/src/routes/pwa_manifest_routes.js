const express = require("express");
const router = express.Router();
const { pwaManifest } = require("../controllers/pwa_manifest_controller");

// No auth — the browser fetches this without credentials during PWA install.
router.get("/", pwaManifest);

module.exports = router;
