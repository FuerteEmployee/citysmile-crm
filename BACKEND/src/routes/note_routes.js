const express = require("express");
const router = express.Router();
const {
  getNotes,
  getNoteRelIdsWithNotes,
  createNote,
  updateNote,
  deleteNote,
} = require("../controllers/note_controller");
const { protect } = require("../middleware/auth");

router.route("/")
  .get(protect, getNotes)
  .post(protect, createNote);

router.get("/exists", protect, getNoteRelIdsWithNotes);

router.route("/:id")
  .put(protect, updateNote)
  .delete(protect, deleteNote);

module.exports = router;
