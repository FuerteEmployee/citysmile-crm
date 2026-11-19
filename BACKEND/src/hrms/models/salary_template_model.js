const mongoose = require("mongoose");

const elementStyleSchema = new mongoose.Schema({
  fontSize: Number,
  fontWeight: String,
  fontStyle: String,
  fontFamily: String,
  color: String,
  backgroundColor: String,
  borderColor: String,
  borderWidth: { type: Number, default: 0 },
  borderStyle: { type: String, default: "solid" },
  borderRadius: { type: Number, default: 0 },
  paddingTop: Number, paddingRight: Number, paddingBottom: Number, paddingLeft: Number,
  textAlign: String,
  opacity: Number,
  letterSpacing: Number,
  lineHeight: Number,
}, { _id: false });

const canvasElementSchema = new mongoose.Schema({
  elId: { type: String, required: true },
  type: {
    type: String, required: true,
    enum: [
      "text", "heading", "dynamicField",
      "earningsTable", "deductionsTable", "leaveTable",
      "infoGrid", "attendanceGrid", "bankGrid", "netPayBar",
      "divider", "image", "rect", "companyHeader",
      "signatureLine", "badge",
    ],
  },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  width: { type: Number, default: 200 },
  height: { type: Number, default: 40 },
  zIndex: { type: Number, default: 1 },
  locked: { type: Boolean, default: false },
  content: String,
  dataKey: String,
  src: String,
  extraData: { type: Object, default: undefined },
  style: { type: elementStyleSchema, default: () => ({}) },
}, { _id: false });

const customFieldSchema = new mongoose.Schema({
  label: { type: String, required: true },
  fieldKey: { type: String, required: true },
  section: {
    type: String,
    enum: ["earnings", "deductions", "attendance", "leave", "bankDetails", "employeeInfo"],
    required: true,
  },
}, { _id: false });

const salaryTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    isDefault: { type: Boolean, default: false },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },

    // Legacy simple branding (used when elements[] is empty)
    companyName: { type: String, default: "" },
    companyAddress: { type: String, default: "" },
    companyLogoUrl: { type: String, default: "" },
    headerColor: { type: String, default: "#4F46E5" },
    accentColor: { type: String, default: "#6366F1" },
    sections: {
      earnings:     { type: Boolean, default: true },
      deductions:   { type: Boolean, default: true },
      attendance:   { type: Boolean, default: true },
      leaveDetails: { type: Boolean, default: true },
      bankDetails:  { type: Boolean, default: true },
    },
    customFields: { type: [customFieldSchema], default: [] },
    footerNote: { type: String, default: "" },

    // Canvas layout (Canva-like editor)
    canvasWidth:  { type: Number, default: 794 },
    canvasHeight: { type: Number, default: 1123 },
    canvasBg:     { type: String, default: "#ffffff" },
    bgImage:      { type: String, default: "" },
    bgOpacity:    { type: Number, default: 0.5 },
    elements:     { type: [canvasElementSchema], default: undefined },

    // Serialised HTML representation (generated from canvas on save).
    // Contains {{token}} placeholders replaced at render time.
    htmlTemplate: { type: String, default: "" },
  },
  { timestamps: true }
);

salaryTemplateSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

module.exports = (mongoose.models["SalaryTemplate"] || mongoose.model("SalaryTemplate", salaryTemplateSchema));
