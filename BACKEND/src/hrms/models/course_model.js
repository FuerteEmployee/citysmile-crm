const mongoose = require("mongoose");

const courseSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    category: {
      type: String,
      enum: ["Finance", "HR", "Inventory", "Sales", "Operations", "Procurement"],
      required: true,
    },
    contentType: {
      type: String,
      enum: ["video", "PDF", "slide_deck", "article"],
      default: "article",
    },
    fileUrl: { type: String },
    thumbnail: { type: String },
    videoUrl: { type: String },
    pdfUrl: { type: String },
    totalLessons: { type: Number, required: true },
    durationMins: { type: Number },
    duration: { type: String },
    tags: [{ type: String }],
    difficultyLevel: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },
    targetDepartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSDepartment",
      default: null,
    },
    isMandatory: { type: Boolean, default: false },
    deadline: { type: Date, default: null },
    status: {
      type: String,
      enum: ["Draft", "Published", "Archived"],
      default: "Published",
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    version: { type: String, default: "v1.0" },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["Course"] || mongoose.model("Course", courseSchema));
