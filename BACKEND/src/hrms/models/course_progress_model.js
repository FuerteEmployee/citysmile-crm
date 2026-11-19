const mongoose = require("mongoose");

const courseProgressSchema = new mongoose.Schema(
  {
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      default: null,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TrainingModule",
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["not_started", "in_progress", "completed"],
      default: "not_started",
    },
    completedLessons: { type: Number, default: 0 },
    percentComplete: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    timeSpentMins: { type: Number, default: 0 },
    quizScore: { type: Number, default: null },
    passed: { type: Boolean, default: null },
    certificateIssued: { type: Boolean, default: false },
    certificateUrl: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["CourseProgress"] || mongoose.model("CourseProgress", courseProgressSchema));
