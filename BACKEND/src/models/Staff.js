const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const staffSchema = new mongoose.Schema(
  {
    firstname: {
      type: String,
      required: true,
      trim: true,
    },
    lastname: {
      // Not required: an HRMS employee can have a one-word name ("Ravi"),
      // and the linked Staff must mirror it rather than keep an old surname.
      // Setup > Staff's form still asks for a Last Name.
      type: String,
      default: "",
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    phonenumber: {
      type: String,
      trim: true,
    },
    admin: {
      type: Boolean,
      default: false,
    },
    is_superadmin: {
      type: Boolean,
      default: false,
    },
    // Set for staff created via the HRMS module's Staff Directory — such
    // accounts log in through the normal staff login but only ever see the
    // HRMS self-service views (Dashboard + My Attendance/Leaves/Expenses),
    // never the rest of the CRM.
    is_hrms_staff: {
      type: Boolean,
      default: false,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
    },
    // Explicit link to this staff member's mirrored HRMS employee profile
    // (src/hrms/models/user_model.js), kept in sync by staff_controller.js.
    hrms_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
    },
    permissions: {
      type: Map, // For direct overrides if needed
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    skype: {
      type: String,
      trim: true,
    },
    facebook: {
      type: String,
      trim: true,
    },
    linkedin: {
      type: String,
      trim: true,
    },
    default_language: {
      type: String,
      default: "System Default",
    },
    direction: {
      type: String,
      default: "System Default",
    },
    email_signature: {
      type: String,
      trim: true,
    },
    departments: [
      {
        type: String,
      },
    ],
    active: {
      type: Boolean,
      default: true,
    },
    two_factor_auth_enabled: {
      type: Boolean,
      default: false,
    },
    two_factor_auth_code: {
      type: String,
    },
    two_factor_auth_code_requested: {
      type: Date,
    },
    // Wrong codes entered for the current 2FA code; the code is discarded at MAX_2FA_ATTEMPTS.
    two_factor_auth_attempts: {
      type: Number,
      default: 0,
    },
    datecreated: {
      type: Date,
      default: Date.now,
    },
    media_path_slug: {
      type: String,
      trim: true,
    },
    google_auth_secret: {
      type: String,
    },
    last_login: {
      type: Date,
    },
    last_ip: {
      type: String,
    },
    last_password_change: {
      type: Date,
    },
    notification_sound: {
      type: String,
      default: "default",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Email only needs to be unique within a tenant — not across the whole platform.
// (Super-admin staff share tenant_id: null, so this still guards that group too.)
staffSchema.index({ tenant_id: 1, email: 1 }, { unique: true });

// Virtual for full name
staffSchema.virtual("full_name").get(function () {
  return `${this.firstname} ${this.lastname}`;
});

// Hash password before saving
staffSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare password
staffSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const Staff = mongoose.model("Staff", staffSchema);

module.exports = Staff;
