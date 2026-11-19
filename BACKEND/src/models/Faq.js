const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  category: { type: String, default: 'General' },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' },
  tenant_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tenant",
    index: true,
  },
}, {
  timestamps: true
});

module.exports = mongoose.model('Faq', faqSchema);
