const mongoose = require("mongoose");

const quizSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    questionText: { type: String, required: true },
    options: [{ type: String }],
    correctAnswer: { type: String, required: true },
    marks: { type: Number, default: 1 },
    linkedTo: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "linkedType",
    },
    linkedType: {
      type: String,
      enum: ["Course", "TrainingModule"],
      default: "Course",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["Quiz"] || mongoose.model("Quiz", quizSchema));
