const KBGroup = require("../models/KBGroup");
const KBArticle = require("../models/KBArticle");

const getKBGroups = async (req, res) => {
  try {
    console.log("Fetching KB Groups... KBGroup model exists:", !!KBGroup);
    const groupFilter = { active: true };
    if (!req.user?.is_superadmin && req.user?.tenant_id) groupFilter.tenant_id = req.user.tenant_id;
    const groups = await KBGroup.find(groupFilter).sort({ group_order: 1 });
    res.json(groups);
  } catch (error) {
    console.error("Fetch Groups Error:", error);
    res.status(500).json({ message: "Failed to fetch groups: " + error.message });
  }
};

const getKBArticles = async (req, res) => {
  try {
    const query = {};
    if (req.query.all !== "true") query.active = true;
    if (req.query.group) query.group = req.query.group;
    if (!req.user?.is_superadmin && req.user?.tenant_id) query.tenant_id = req.user.tenant_id;
    const articles = await KBArticle.find(query).populate("group", "name color").sort({ article_order: 1 });
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createKBArticle = async (req, res) => {
  try {
    const { subject, group, internal, disabled, description } = req.body;
    console.log("Creating Article with data:", req.body);
    const article = await KBArticle.create({
      subject,
      group,
      staff_article: internal,
      active: !disabled,
      description,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(article);
  } catch (error) {
    console.error("Create Article Error:", error);
    res.status(500).json({ message: "Article Creation Failed: " + error.message });
  }
};

const createKBGroup = async (req, res) => {
  try {
    const { name, color, description, order, disabled } = req.body;
    console.log("Creating Group with data:", req.body);
    const group = await KBGroup.create({
      name,
      color,
      description,
      group_order: order,
      active: !disabled,
      tenant_id: req.user?.tenant_id,
    });
    res.status(201).json(group);
  } catch (error) {
    console.error("Create Group Error:", error);
    res.status(500).json({ message: "Group Creation Failed: " + error.message });
  }
};

const updateKBArticle = async (req, res) => {
  try {
    const { subject, group, internal, disabled, description } = req.body;
    const article = await KBArticle.findByIdAndUpdate(
      req.params.id,
      {
        subject,
        group,
        staff_article: internal,
        active: !disabled,
        description
      },
      { new: true }
    );
    if (!article) return res.status(404).json({ message: "Article not found" });
    res.json(article);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteKBArticle = async (req, res) => {
  try {
    const article = await KBArticle.findByIdAndDelete(req.params.id);
    if (!article) return res.status(404).json({ message: "Article not found" });
    res.json({ message: "Article deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateKBGroup = async (req, res) => {
  try {
    const { name, color, description, order, disabled } = req.body;
    const group = await KBGroup.findByIdAndUpdate(
      req.params.id,
      {
        name,
        color,
        description,
        group_order: order,
        active: !disabled
      },
      { new: true }
    );
    if (!group) return res.status(404).json({ message: "Group not found" });
    res.json(group);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteKBGroup = async (req, res) => {
  try {
    const group = await KBGroup.findByIdAndDelete(req.params.id);
    if (!group) return res.status(404).json({ message: "Group not found" });
    res.json({ message: "Group deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { 
  getKBGroups, getKBArticles, 
  createKBArticle, createKBGroup,
  updateKBArticle, deleteKBArticle,
  updateKBGroup, deleteKBGroup 
};
