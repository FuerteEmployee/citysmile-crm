const Faq = require('../models/Faq');

exports.getAllFaqs = async (req, res) => {
  try {
    const faqFilter = {};
    if (!req.user?.is_superadmin && req.user?.tenant_id) faqFilter.tenant_id = req.user.tenant_id;
    const faqs = await Faq.find(faqFilter).populate('created_by', 'firstname lastname').sort({ createdAt: -1 });
    res.status(200).json(faqs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createFaq = async (req, res) => {
  try {
    const { question, answer, category, status } = req.body;
    const newFaq = new Faq({
      question,
      answer,
      category,
      status,
      created_by: req.user ? req.user._id : null,
      tenant_id: req.user?.tenant_id,
    });
    await newFaq.save();
    res.status(201).json(newFaq);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateFaq = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedFaq = await Faq.findByIdAndUpdate(
      id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedFaq) {
      return res.status(404).json({ message: 'FAQ not found' });
    }
    res.status(200).json(updatedFaq);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteFaq = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedFaq = await Faq.findByIdAndDelete(id);
    if (!deletedFaq) {
      return res.status(404).json({ message: 'FAQ not found' });
    }
    res.status(200).json({ message: 'FAQ deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
