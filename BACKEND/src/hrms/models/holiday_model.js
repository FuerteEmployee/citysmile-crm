const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
    name: { type: String, required: true, trim: true },
    // YYYY-MM-DD — same string format attendance.date uses, so holiday dates
    // join cleanly against attendance records and IST day boundaries.
    date: {
      type: String,
      required: true,
      index: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format"],
    },
    // Last day of the holiday (inclusive). Defaults to `date`, so single-day
    // holidays and multi-day festivals (e.g. 3-day Diwali) share one shape.
    endDate: {
      type: String,
      index: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "endDate must be in YYYY-MM-DD format"],
    },
    type: {
      type: String,
      enum: ["Festival", "National", "Regional", "Company"],
      default: "Festival",
    },
    // Empty array = applies to every branch. Ids are matched against both
    // User.storeId and User.hrmsBranchId since employees carry either.
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "HRMSBranch" }],
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Mongoose 9 middleware: no `next` callback — throw to abort.
holidaySchema.pre("validate", function () {
  if (!this.endDate) this.endDate = this.date;
  if (this.endDate < this.date) {
    throw new Error("endDate cannot be before the start date");
  }
});

// Unique per-tenant rather than globally, so two different tenants can each
// have their own "Diwali" on the same date without colliding.
holidaySchema.index({ tenant_id: 1, date: 1, name: 1 }, { unique: true });

module.exports = (mongoose.models["Holiday"] || mongoose.model("Holiday", holidaySchema, "holidays"));
