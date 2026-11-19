const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getBookmarks,
  createBookmark,
  syncBookmarks,
  deleteBookmark,
  deleteAllBookmarks,
  deleteByChromeId,
  updateBookmark
} = require('../controllers/bookmark_controller');

router.route('/')
  .get(protect, getBookmarks)
  .post(protect, createBookmark)
  .delete(protect, deleteAllBookmarks);

router.post('/sync', protect, syncBookmarks);

router.route('/chrome/:chromeId')
  .delete(protect, deleteByChromeId);

router.route('/:id')
  .put(protect, updateBookmark)
  .delete(protect, deleteBookmark);

module.exports = router;
