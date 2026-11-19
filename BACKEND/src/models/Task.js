const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
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
    priority: {
      type: Number,
      default: 2, // 1: Low, 2: Medium, 3: High, 4: Urgent
    },
    status: {
      type: Number,
      default: 1, // 1: Not Started, 2: Awaiting Feedback, 3: Testing, 4: In Progress, 5: Complete
    },
    category: {
      type: String,
      enum: ["Visit", "Trial", "Query", "Inquiry", "To-Do", "Unique Visit"],
      default: "To-Do",
    },
    inquiry_outcome: {
      type: String,
      enum: ["Won", "Lost", null],
      default: null,
    },
    dateadded: {
      type: Date,
      default: Date.now,
    },
    startdate: Date,
    duedate: Date,
    datefinished: Date,
    addedfrom: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "addedfrom_model",
    },
    addedfrom_model: {
      type: String,
      enum: ["Staff", "Contact"],
      default: "Staff",
    },
    is_added_from_contact: {
      type: Boolean,
      default: false,
    },
    rel_id: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "rel_type_model",
    },
    rel_type: {
      type: String,
      enum: ["project", "lead", "customer", "invoice", "estimate", "contract", "ticket", "expense", "home", "office", "field"],
    },
    rel_type_model: {
      type: String,
      enum: ["Project", "Lead", "Client"], // Simplify for now
    },
    billable: {
      type: Boolean,
      default: false,
    },
    billed: {
      type: Boolean,
      default: false,
    },
    invoice_id: mongoose.Schema.Types.ObjectId,
    hourly_rate: {
      type: Number,
      default: 0,
    },
    milestone: {
      type: Number,
      default: 0,
    },
    kanban_order: {
      type: Number,
      default: 0,
    },
    milestone_order: {
      type: Number,
      default: 0,
    },
    visible_to_client: {
      type: Boolean,
      default: false,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    assignees: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
    followers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
    // Tags from the task form (were dropped on save).
    tags: [String],
    // Set once the Cron Job deadline reminder went out; cleared when the due date changes.
    deadline_notified: { type: Boolean, default: false },
    checklists: [
      {
        title: { type: String, required: true },
        completed: { type: Boolean, default: false },
        added_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        dateadded: { type: Date, default: Date.now },
      }
    ],
    comments: [
      {
        text: { type: String, required: true },
        added_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
        dateadded: { type: Date, default: Date.now },
      }
    ],
    branch: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

const Task = mongoose.model("Task", taskSchema);

module.exports = Task;
