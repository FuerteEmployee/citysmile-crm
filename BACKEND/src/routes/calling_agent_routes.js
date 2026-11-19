const express = require("express");
const router = express.Router();
const { protect, staffOnly } = require("../middleware/auth");
const {
  getCalls,
  getCallDetail,
  streamRecording,
  resolveCustomer,
  retryTranscription,
} = require("../controllers/calling_agent_controller");

// TODO(Phase 5/6): once a "Calling Agent" permission module is registered
// (Setup > Roles), add checkPermission("Calling Agent", "View"/"Edit") here
// too — left as staffOnly for now since that module doesn't exist in the
// roles data model yet and referencing it unseeded is an unverified
// failure mode.
router.use(protect, staffOnly);

router.get("/calls", getCalls);
router.get("/calls/:id", getCallDetail);
router.get("/calls/:id/recording", streamRecording);
router.post("/calls/:id/resolve-customer", resolveCustomer);
router.post("/calls/:id/retry-transcription", retryTranscription);

module.exports = router;
