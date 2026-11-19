const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

// This "User" collection is HRMS's own employee-master record, distinct in shape
// from the main CRM's "Staff" collection (src/models/Staff.js, which powers
// Chat/Goals/main-CRM auth) but kept in sync with it: Setup > Staff is the single
// creation entry point, and src/controllers/staff_controller.js mirrors every
// create/update/delete here (see linkHrmsProfile/syncHrmsProfile there), in
// addition to HRMS's own onboarding paths (the single-employee "Add Employee"
// form, and the bulk import flow in src/hrms/controllers/import_employees_controller.js).
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    email: {
      type: String,
      required: true,
      // Same as Staff.email, so a Staff login and its HRMS profile always
      // compare equal (checked: no existing HRMS email had capitals/spaces).
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
      required: true,
    },

    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSRole",
    },

    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    hrmsBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRMSBranch",
      default: null,
    },

    // Mirror link back to the main CRM's Staff login (src/models/Staff.js)
    // that this HRMS profile was created for/from — kept in sync by
    // staff_controller.js (Setup > Staff is the single creation entry point).
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    // Scopes this employee record to one tenant deployment (see src/models/Staff.js's
    // identical field) — every list/detail/create/update/delete in user_controller.js
    // must filter by this so different tenants sharing this backend never see each
    // other's HRMS employees.
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isTrackingActive: {
      type: Boolean,
      default: false,
    },
    attendanceRequired: {
      type: Boolean,
      default: true,
    },
    mobile: {
      type: String,
      default: "",
    },
    avatar: {
      type: String,
      default: "",
    },
    fcmToken: {
      type: String,
      default: "",
    },
    // Device lock — stores the approved device fingerprint ID and friendly name
    registeredDeviceId: {
      type: String,
      default: null,
    },
    registeredDeviceName: {
      type: String,
      default: null,
    },
    // Set true when an admin removes/revokes a device. Blocks the "first login
    // auto-registers" shortcut so a removed device can't silently re-register —
    // it must go through a fresh approval. Cleared once a device is approved.
    requireDeviceApproval: {
      type: Boolean,
      default: false,
    },
    // --- Employee Master Fields ---
    employeeCode: { type: String, default: "" },
    gender: { type: String, enum: ["Male", "Female", "Other", ""], default: "" },
    dob: { type: Date },
    bloodGroup: { type: String, default: "" },
    education: { type: String, default: "" },
    totalExperience: { type: String, default: "" },
    joiningDate: { type: Date },
    employmentType: { type: String, enum: ["permanent", "contract", "intern", "probation", "Full Time", "Part Time", "full-time", "part-time", ""], default: "" },
    payType: { type: String, enum: ["Monthly", "Weekly", "Daily", "Hourly", ""], default: "Monthly" },
    salaryAmount: { type: Number, default: 0, min: 0 },
    /* "screen_time" = Screen Time manages salary + incentive
       "branch"      = Branch manages salary, Screen Time manages incentive only */
    salaryManagedBy: {
      type: String,
      enum: ["screen_time", "branch"],
      default: "screen_time",
    },
    managingCompanyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ManagingCompany",
      default: null,
    },

    department: { type: mongoose.Schema.Types.ObjectId, ref: "HRMSDepartment", default: null },
    designation: { type: mongoose.Schema.Types.ObjectId, ref: "Designation", default: null },
    salaryStructureId: { type: mongoose.Schema.Types.ObjectId, ref: "SalaryStructure", default: null },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    franchiseId: { type: mongoose.Schema.Types.ObjectId, ref: "Franchise", default: null },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: "Shift", default: null },

    isSalesperson: { type: Boolean, default: false },

    // Work Settings
    weeklyHolidays: { type: [String], default: [] }, // ["Monday", "Sunday"]
    attendanceExceptions: { type: [String], default: [] },

    address: {
      current: { type: String, default: "" },
      permanent: { type: String, default: "" },
    },
    residentialPhone: { type: String, default: "" },

    emergencyContact: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      relation: { type: String, default: "" },
    },

    bankInfo: {
      accountName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifscCode: { type: String, default: "" },
      bankName: { type: String, default: "" },
      branchCity: { type: String, default: "" },
    },

    legalDocuments: {
      panNumber: { type: String, default: "" },
      panUrl: { type: String, default: "" },
      aadhaarNumber: { type: String, default: "" },
      aadhaarUrl: { type: String, default: "" },
      passportPhotoUrl: { type: String, default: "" },
    },



    documents: [
      {
        docType: { type: String }, // e.g., 'ID Proof', 'Address Proof', 'PAN', 'Aadhaar'
        fileUrl: { type: String },
        verified: { type: Boolean, default: false },
      },
    ],
    lastKnownLocation: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
      },
      address: { type: String, default: "" },
      updatedAt: { type: Date },
    },
  },
  { timestamps: true },
);

// Geo-spatial index for user searching by proximity
UserSchema.index({ "lastKnownLocation.coordinates": "2dsphere" });

// Email only needs to be unique within a tenant, not across the whole platform —
// mirrors src/models/Staff.js's identical { tenant_id, email } unique index.
// (Super-admin/global users share tenant_id: null, so this still guards that group too.)
UserSchema.index({ tenant_id: 1, email: 1 }, { unique: true });

UserSchema.index({ storeId: 1, role: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

module.exports = (mongoose.models["User"] || mongoose.model("User", UserSchema));
