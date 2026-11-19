const express = require("express");
const router = express.Router();
const { upload, getFiles, uploadFiles, deleteFile } = require("../controllers/file_controller");
const { protect } = require("../middleware/auth");

router.use(protect);

router.get("/", getFiles);
router.post("/", upload.array("files"), uploadFiles);
router.delete("/:fileId", deleteFile);

module.exports = router;
