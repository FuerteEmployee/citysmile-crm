const mongoose = require("mongoose");

const trainingModuleSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    moduleTitle: { type: String, required: true },
    moduleDescription: { type: String },
    trainingItems: [
      {
        courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course" },
        order: { type: Number, default: 0 },
      },
    ],
    passScore: { type: Number, default: null },
    status: {
      type: String,
      enum: ["Draft", "Published", "Archived"],
      default: "Published",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["TrainingModule"] || mongoose.model("TrainingModule", trainingModuleSchema));
