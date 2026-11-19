const express = require('express');
const router = express.Router();
const faqController = require('../controllers/faqController');
const { protect } = require('../middleware/auth'); // Check if it's protect or just auth.

router.get('/', faqController.getAllFaqs);
router.post('/', protect, faqController.createFaq);
router.put('/:id', protect, faqController.updateFaq);
router.delete('/:id', protect, faqController.deleteFaq);

module.exports = router;
