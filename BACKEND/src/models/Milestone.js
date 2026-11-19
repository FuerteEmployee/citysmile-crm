const mongoose = require("mongoose");

const milestoneSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    milestone_order: {
      type: Number,
      default: 0,
    },
    datecreated: {
      type: Date,
      default: Date.now,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Milestone = mongoose.model("Milestone", milestoneSchema);

module.exports = Milestone;
