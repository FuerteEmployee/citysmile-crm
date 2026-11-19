const mongoose = require("mongoose");

// An employee's enrolled face for HRMS Face Attendance: one SFace embedding
// (128 numbers) per enrolment photo. The Python face service
// (CRM-BACKEND/face-service) only turns images into embeddings and keeps
// nothing — matching against these happens in utils/faceRecognition.js.
// Having a FaceProfile is also what switches on the selfie face check for the
// employee's own punches (attendance_controller punchIn/punchOut).
const FaceProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    embeddings: { type: [[Number]], required: true },
    photoUrls: { type: [String], default: [] },
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = (mongoose.models["FaceProfile"] || mongoose.model("FaceProfile", FaceProfileSchema));
