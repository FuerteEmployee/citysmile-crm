const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    description: String,
    status: {
      type: Number,
      default: 1, // 1: Not Started, 2: In Progress, 3: On Hold, 4: Finished, 5: Cancelled
    },
    clientid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    billing_type: {
      type: Number,
      default: 1, // 1: Fixed Rate, 2: Project Hours, 3: Task Hours
    },
    start_date: Date,
    deadline: Date,
    project_created: {
      type: Date,
      default: Date.now,
    },
    addedfrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    project_cost: Number,
    project_rate_per_hour: Number,
    estimated_hours: Number,
    progress: {
      type: Number,
      default: 0,
    },
    progress_from_tasks: {
      type: Boolean,
      default: false,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    team: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
    visible_tabs: [String],
    settings: {
      view_tasks: { type: Boolean, default: true },
      create_tasks: { type: Boolean, default: false },
      edit_tasks: { type: Boolean, default: false },
      comment_on_tasks: { type: Boolean, default: true },
      view_task_comments: { type: Boolean, default: true },
      view_task_attachments: { type: Boolean, default: true },
      view_task_checklist_items: { type: Boolean, default: true },
      upload_on_tasks: { type: Boolean, default: true },
      view_task_total_logged_time: { type: Boolean, default: true },
      view_finance_overview: { type: Boolean, default: false },
      upload_files: { type: Boolean, default: true },
      open_discussions: { type: Boolean, default: true },
      view_milestones: { type: Boolean, default: true },
      view_gantt: { type: Boolean, default: true },
      view_timesheets: { type: Boolean, default: true },
      view_activity_log: { type: Boolean, default: true },
      view_team_members: { type: Boolean, default: true },
      hide_tasks_on_main_tasks_table: { type: Boolean, default: false },
    },
    tags: [String],
    send_notifications: {
      type: String,
      default: "none",
    },
    branch: {
      type: String,
      default: "",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
  },
  {
    timestamps: true,
  }
);

const Project = mongoose.model("Project", projectSchema);

module.exports = Project;
