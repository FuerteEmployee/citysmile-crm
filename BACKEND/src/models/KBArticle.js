const mongoose = require("mongoose");

const kbArticleSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: true,
    },
    description: {
      type: String, // Article content
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KBGroup",
      required: true,
    },
    article_order: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
    staff_article: {
      type: Boolean,
      default: false,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const KBArticle = mongoose.model("KBArticle", kbArticleSchema);

module.exports = KBArticle;
