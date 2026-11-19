const express = require("express");
const multer = require("multer");
const router = express.Router();
const meetingController = require("../controllers/meeting_controller");
const { protect } = require("../middleware/auth");

// Recording files go straight to S3 (see meetingRecordingService.js) — held in
// memory only long enough to stream to the PutObjectCommand, never written to
// local disk. Capped at 500MB per file as a sanity limit for a single meeting.
const recordingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.use(protect);

router.get("/", meetingController.getMeetings);
router.post("/import", meetingController.importMeetings);
router.get("/:id", meetingController.getMeetingById);
router.post("/", meetingController.createMeeting);
router.put("/:id", meetingController.updateMeeting);
router.post("/:id/summarize", meetingController.summarizeMeeting);
router.post("/:id/scribe-turn", meetingController.scribeTurn);
router.post("/:id/scribe-diagnostic", meetingController.scribeDiagnostic);
router.post("/:id/recording-consent", meetingController.setRecordingConsent);
router.post("/:id/recording", recordingUpload.single("file"), meetingController.uploadRecording);
router.get("/:id/recording/:recordingId/url", meetingController.getRecordingUrl);
router.delete("/:id/recording/:recordingId", meetingController.deleteRecording);
router.delete("/:id", meetingController.deleteMeeting);

module.exports = router;
