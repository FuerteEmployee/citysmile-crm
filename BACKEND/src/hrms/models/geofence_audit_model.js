const mongoose = require("mongoose");

// Silent, automatic trail for every geofence auto-punch-out. Written on each
// event (no human action needed) so that IF an employee ever disputes a
// punch-out, you can see exactly why it fired — the windowed-median position,
// the distance, and how many fixes backed the decision. Nobody reviews this
// routinely; it's a record, not a task.
const geofenceAuditSchema = new mongoose.Schema(
  {
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    date:          { type: String },   // YYYY-MM-DD (IST)
    time:          { type: String },   // HH:mm:ss (IST)
    branchId:      { type: mongoose.Schema.Types.ObjectId, ref: "HRMSBranch" },
    radiusM:       { type: Number },   // geofence radius used (metres)
    medianLat:     { type: Number },
    medianLng:     { type: Number },
    distanceM:     { type: Number },   // median distance from branch centre
    windowMin:     { type: Number },   // size of the decision window
    fixesInWindow: { type: Number },   // good fixes the median was computed over
    trigger:       { type: String, enum: ["background", "client", "replay"] },
    // The exact fixes the median was computed over — raw evidence for
    // "I never left" disputes. t is the client capture time of each fix.
    fixes: [
      {
        _id: false,
        lat: Number,
        lng: Number,
        acc: Number,
        t:   Date,
      },
    ],
  },
  { timestamps: true },
);

module.exports = (mongoose.models["GeofenceAudit"] || mongoose.model("GeofenceAudit", geofenceAuditSchema));
