const mongoose = require("mongoose");

const mainSidebarSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  url: {
    type: String,
    required: true,
  },
  icon: {
    type: String,
    required: true,
  },
  permission: {
    type: String,
    default: "",
  },
  group: {
    type: String,
    required: true,
    enum: ["Main", "Customers", "Sales", "Management", "Utilities", "Reports", "Setup", "HRMS"],
    default: "Main"
  },
  order: {
    type: Number,
    default: 0,
  },
  active: {
    type: Boolean,
    default: true,
  }
}, { timestamps: true });

module.exports = mongoose.model("MainSidebar", mainSidebarSchema);
