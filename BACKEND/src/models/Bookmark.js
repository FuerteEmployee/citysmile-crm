const mongoose = require('mongoose');

const bookmarkSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  url: {
    type: String,
    required: true,
  },
  chromeBookmarkId: {
    type: String,
  },
  folder: {
    type: String,
    default: "Uncategorized"
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
  },
  is_private: {
    type: Boolean,
    default: false,
  },
  tenant_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  dateAdded: {
    type: Date,
    default: Date.now,
  }
}, { timestamps: true });

module.exports = mongoose.model('Bookmark', bookmarkSchema);
