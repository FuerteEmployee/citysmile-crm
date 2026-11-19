const express = require("express");
const router = express.Router();
const trainingController = require("../controllers/training_controller");
const { protect } = require("../middleware/auth_middleware");
const upload = require("../utils/cloudinary_config");

// Stats
router.get("/stats", protect, trainingController.getTrainingStats);

// Training Content (Courses) — upload.any() to accept thumbnail + file in one request
router.get("/courses", protect, trainingController.getCourses);
router.post("/courses", protect, upload.any(), trainingController.createCourse);
router.get("/courses/:id", protect, trainingController.getCourse);
router.put("/courses/:id", protect, upload.any(), trainingController.updateCourse);
router.delete("/courses/:id", protect, trainingController.deleteCourse);
router.patch("/courses/:id/progress", protect, trainingController.updateCourseProgress);

// Course Assignments
router.post("/courses/:id/assign", protect, trainingController.assignCourse);
router.get("/courses/:id/assignments", protect, trainingController.getCourseAssignments);
router.delete("/courses/:id/assign/:staffId", protect, trainingController.unassignStaffFromCourse);

// SOPs
router.get("/sops", protect, trainingController.getSOPs);
router.post("/sops", protect, trainingController.createSOP);
router.delete("/sops/:id", protect, trainingController.deleteSOP);

// Training Modules
router.get("/modules", protect, trainingController.getModules);
router.post("/modules", protect, trainingController.createModule);
router.delete("/modules/:id", protect, trainingController.deleteModule);

// Quizzes
router.get("/quizzes", protect, trainingController.getQuizzes);
router.post("/quizzes", protect, trainingController.createQuiz);
router.delete("/quizzes/:id", protect, trainingController.deleteQuiz);
router.post("/quizzes/submit", protect, trainingController.submitQuiz);

module.exports = router;
