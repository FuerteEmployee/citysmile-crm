const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { toE164 } = require("../utils/phoneNormalize");

const contactSchema = new mongoose.Schema(
  {
    userid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    is_primary: {
      type: Boolean,
      default: false,
    },
    firstname: {
      type: String,
      required: true,
      trim: true,
    },
    lastname: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phonenumber: {
      type: String,
      trim: true,
    },
    // Normalized E.164 shadow of `phonenumber` — see Client.js for why.
    phoneE164: {
      type: String,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
    },
    active: {
      type: Boolean,
      default: true,
    },
    datecreated: {
      type: Date,
      default: Date.now,
    },
    last_login: {
      type: Date,
    },
    last_ip: {
      type: String,
    },
    email_verified_at: {
      type: Date,
    },
    invoice_emails: { type: Boolean, default: true },
    estimate_emails: { type: Boolean, default: true },
    credit_note_emails: { type: Boolean, default: true },
    contract_emails: { type: Boolean, default: true },
    task_emails: { type: Boolean, default: true },
    project_emails: { type: Boolean, default: true },
    ticket_emails: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for full name
contactSchema.virtual("full_name").get(function () {
  return `${this.firstname} ${this.lastname}`;
});

// Hash password before saving
contactSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare password
contactSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

contactSchema.pre("save", function (next) {
  if (this.isModified("phonenumber")) {
    this.phoneE164 = toE164(this.phonenumber) || undefined;
  }
  next();
});

const Contact = mongoose.model("Contact", contactSchema);

module.exports = Contact;
